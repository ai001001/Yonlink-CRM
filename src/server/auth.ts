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
import type { UserRole } from '@/generated/prisma/enums';
import { prisma } from './db';
import { audit, requestMeta, type RequestMeta } from './audit';
import { ApiError } from './errors';

/** 会话有效期 12 小时 / Session lifetime: 12 hours */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 服务端身份上下文 / Server-side identity context */
export interface AuthContext {
  userId: string;
  organizationId: string;
  /** 当前角色（每个请求从数据库读取）/ current role (read from the DB on every request) */
  role: UserRole;
  /** 请求来源（用于审计）/ request origin (for auditing) */
  meta?: RequestMeta;
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
export async function login(email: string, password: string, meta?: RequestMeta) {
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
    // 账号存在时记录失败（不存在的邮箱无所属组织，不记录；不记录密码）
    // log failures for existing accounts only (unknown emails have no organization); never the password
    if (user) {
      await prisma.$transaction((tx) =>
        audit(tx, {
          organizationId: user.organizationId,
          actorId: user.id,
          action: 'auth.login_failed',
          entityType: 'auth',
          entityId: user.id,
          changes: { reason: ok ? 'inactive' : 'bad_password' },
          meta,
        }),
      );
    }
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  failures.delete(key);

  const token = randomBytes(32).toString('base64url');
  await prisma.$transaction(async (tx) => {
    await tx.session.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now + SESSION_TTL_MS) },
    });
    await audit(tx, { organizationId: user.organizationId, actorId: user.id, action: 'auth.login', entityType: 'auth', entityId: user.id, meta });
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
    include: { user: { select: { id: true, organizationId: true, isActive: true, role: true } } },
  });
  if (!session || session.expiresAt.getTime() <= Date.now() || !session.user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }
  return { userId: session.user.id, organizationId: session.user.organizationId, role: session.user.role, meta: requestMeta(req) };
}

/**
 * 注销当前会话。
 * Revoke the current session.
 */
export async function logout(req: Request): Promise<void> {
  const token = bearer(req);
  if (!token) return;
  await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, organizationId: true } } },
    });
    if (!session) return;
    await tx.session.delete({ where: { id: session.id } });
    await audit(tx, {
      organizationId: session.user.organizationId,
      actorId: session.user.id,
      action: 'auth.logout',
      entityType: 'auth',
      entityId: session.user.id,
      meta: requestMeta(req),
    });
  });
}
