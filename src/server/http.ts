/**
 * API 通用工具：统一错误格式、CORS、请求体校验与路由包装。
 * Shared API utilities: uniform error format, CORS, body validation and route wrapper.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { authenticate, type AuthContext } from './auth';
import { ApiError, notFound } from './errors';

export { ApiError, notFound } from './errors';

/**
 * 计算允许的跨域来源（GitHub Pages 演示前端）。
 * Compute the allowed CORS origin (GitHub Pages demo frontend).
 * @param req 请求 / request
 * @returns 允许时返回来源，否则 null / the origin when allowed, otherwise null
 */
function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const list = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

/**
 * 附加 CORS 与安全响应头。
 * Attach CORS and security headers.
 */
function withHeaders(req: Request, res: Response): Response {
  const origin = allowedOrigin(req);
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
    res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.headers.set('Access-Control-Max-Age', '600');
    // 允许跨域前端读取导出信息 / let the cross-origin frontend read export metadata
    res.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Count, X-Export-Truncated');
  }
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
}

/**
 * 把任意异常转换为业务异常（未知异常记录日志并转为 INTERNAL_ERROR，不泄露内部信息）。
 * Convert any thrown value into an ApiError (unknown errors are logged and become INTERNAL_ERROR).
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof z.ZodError) return new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', fieldErrors(err));
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2025：记录不存在 / record missing
    if (err.code === 'P2025') return notFound();
    // P2002：唯一约束冲突（如邮箱已存在）/ unique constraint (e.g. email already used)
    if (err.code === 'P2002') return new ApiError(409, 'CONFLICT', 'Duplicate value');
    // P2003：外键约束 / FK violation
    if (err.code === 'P2003') return new ApiError(409, 'CONFLICT', 'Related records prevent this operation');
  }
  console.error('[api] unexpected error', err instanceof Error ? err.message : 'unknown');
  return new ApiError(500, 'INTERNAL_ERROR', 'Internal server error');
}

/**
 * 生成 JSON 错误响应。
 * Build a JSON error response.
 */
function errorResponse(err: unknown): Response {
  const e = toApiError(err);
  return Response.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status });
}

/**
 * 将 Zod 错误转换为字段错误表。
 * Flatten a Zod error into a field → messages map.
 */
export function fieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * 读取并校验 JSON 请求体。
 * Read and validate a JSON request body.
 * @param req 请求 / request
 * @param schema Zod schema
 */
export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Body must be valid JSON');
  }
  return schema.parse(raw);
}

/**
 * 读取并校验查询参数。
 * Read and validate query parameters.
 */
export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params);
}

/** 路由参数（Next.js 16 中为 Promise）/ Route params (a Promise in Next.js 16) */
export type RouteParams = { params: Promise<Record<string, string>> };

type PublicHandler = (req: Request, route: RouteParams) => Promise<Response>;
type AuthedHandler = (req: Request, ctx: AuthContext, route: RouteParams) => Promise<Response>;

/**
 * 包装无需登录的路由。
 * Wrap a route that does not require authentication.
 */
export function publicRoute(handler: PublicHandler) {
  return async (req: Request, route: RouteParams): Promise<Response> => {
    try {
      return withHeaders(req, await handler(req, route));
    } catch (err) {
      return withHeaders(req, errorResponse(err));
    }
  };
}

/**
 * 包装需要登录的路由：每个请求都在服务端校验会话，组织 ID 只来自会话。
 * Wrap an authenticated route: every request verifies the session server-side;
 * the organization id comes only from the session.
 */
export function authedRoute(handler: AuthedHandler) {
  return publicRoute(async (req, route) => {
    const ctx = await authenticate(req);
    return handler(req, ctx, route);
  });
}

/**
 * 预检请求处理器。
 * Handler for CORS preflight requests.
 */
export function preflight(req: Request): Response {
  return withHeaders(req, new Response(null, { status: 204 }));
}

/** UUID 校验 / UUID validator */
export const uuid = z.uuid();

/**
 * 读取并校验 [id] 路由参数，非法时视为不存在。
 * Read the [id] route param; malformed ids are treated as not found.
 */
export async function routeId(route: RouteParams, name = 'id'): Promise<string> {
  const value = (await route.params)[name];
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/**
 * CSV 文件响应（附件下载）。
 * CSV attachment response.
 */
export function csvResponse(filename: string, csv: string, extra: Record<string, string> = {}): Response {
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, ...extra },
  });
}
