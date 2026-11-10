/**
 * 认证：Argon2id 密码 + 不透明服务端会话令牌（数据库只存 SHA-256 哈希）。
 * Authentication: Argon2id passwords + opaque server-side session tokens (only SHA-256 hashes are stored).
 *
 * 令牌通过 `Authorization: Bearer` 传递，便于 GitHub Pages 跨域前端调用且不受 CSRF 影响。
 * Tokens travel in `Authorization: Bearer`, which works for the cross-origin GitHub Pages
 * frontend and is not exposed to CSRF.
 */
import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { prisma } from './db';
import { ApiError } from './errors';

/** 会话有效期 12 小时 / Session lifetime: 12 hours */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 服务端身份上下文 / Server-side identity context */
export interface AuthContext {
  userId: string;
  organizationId: string;
}

/**
 * 计算令牌哈希。
 * Hash a session token.
 * @param token 原始令牌 / raw token
 * @returns 十六进制 SHA-256 / hex SHA-256
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 使用 Argon2id 计算密码哈希。
 * Hash a password with Argon2id.
 */
export function hashPassword(password: string): Promise<string> {
  // @node-rs/argon2 默认算法即 Argon2id / default algorithm is Argon2id
  return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

// 防止用户枚举：用户不存在时也执行一次校验 / anti-enumeration: verify against a dummy hash too
let dummyHash: Promise<string> | undefined;

// 简单内存限流：同一邮箱 15 分钟内最多 10 次失败 / in-memory limiter: 10 failures per email per 15 min
const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * 清空登录限流状态（仅供测试）。
 * Reset the login limiter (tests only).
 */
export function resetLoginLimiter(): void {
  failures.clear();
}

/**
 * 校验邮箱密码并创建会话。
 * Verify credentials and create a session.
 * @returns 原始令牌（仅此一次返回）与用户信息 / the raw token (returned once) and the user
 */
export async function login(email: string, password: string) {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = failures.get(key);
  if (entry && entry.resetAt > now && entry.count >= MAX_FAILURES) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many failed attempts');
  }

  const user = await prisma.user.findUnique({ where: { email: key } });
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const ok = await verify(user?.passwordHash ?? (await dummyHash), password);
  if (!user || !ok || !user.isActive) {
    const next = entry && entry.resetAt > now ? entry.count + 1 : 1;
    failures.set(key, { count: next, resetAt: entry && entry.resetAt > now ? entry.resetAt : now + WINDOW_MS });
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  failures.delete(key);

  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now + SESSION_TTL_MS) },
  });
  return { token, user: { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId } };
}

/**
 * 从请求头取出 Bearer 令牌。
 * Extract the Bearer token from the request.
 */
function bearer(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * 每个请求向 PostgreSQL 校验会话、用户状态，返回身份上下文。
 * Verify session and user state against PostgreSQL on every request.
 * @throws ApiError 401 未登录或会话失效 / not signed in or session invalid
 */
export async function authenticate(req: Request): Promise<AuthContext> {
  const token = bearer(req);
  if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, organizationId: true, isActive: true } } },
  });
  if (!session || session.expiresAt.getTime() <= Date.now() || !session.user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }
  return { userId: session.user.id, organizationId: session.user.organizationId };
}

/**
 * 注销当前会话。
 * Revoke the current session.
 */
export async function logout(req: Request): Promise<void> {
  const token = bearer(req);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}
