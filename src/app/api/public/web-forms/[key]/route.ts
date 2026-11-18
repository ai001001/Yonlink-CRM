/**
 * 公开网页表单（无需登录）/ Public web form (no sign-in).
 * GET  /api/public/web-forms/:key — 表单显示配置 / settings for rendering the form
 * POST /api/public/web-forms/:key — 提交并生成线索（请求体不超过 16 KB，限流）/ submit to create a lead (16 KB cap, rate-limited)
 */
import { requestMeta } from '@/server/audit';
import { ApiError, preflight, publicRoute, type RouteParams } from '@/server/http';
import { publicWebForm, submissionSchema, submitWebForm } from '@/server/modules/web-forms';

const MAX_BYTES = 16 * 1024;

/** 公开标识（不是 UUID，单独读取）/ the public key (not a UUID, read directly) */
async function keyOf(route: RouteParams): Promise<string> {
  return (await route.params).key ?? '';
}

export const GET = publicRoute(async (_req, route) => Response.json(await publicWebForm(await keyOf(route))));

export const POST = publicRoute(async (req, route) => {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Body must be valid JSON');
  }
  return Response.json(await submitWebForm(await keyOf(route), submissionSchema.parse(raw), requestMeta(req)));
});
export const OPTIONS = preflight;
