/**
 * 客户门户认证（与员工登录完全分开）：门户用户用组织门户标识 + 邮箱 + 密码登录，密码 Argon2id，
 * 会话令牌以 `ylp_` 开头、数据库只存 SHA-256 哈希、12 小时有效。员工令牌不能访问门户接口，门户令牌也不能访问员工接口。
 * - 每个请求都向 PostgreSQL 校验会话、门户用户状态、组织门户是否启用、联系人是否仍存在；组织、联系人、客户只来自会话。
 * - 登录失败限流：同一门户同一邮箱 15 分钟内最多 10 次失败；邮箱不存在时也执行一次哈希校验，避免枚举。
 * - 邀请：员工生成一次性邀请链接（令牌只返回一次、数据库只存哈希、7 天有效），客户设置密码后启用并登录。
 * Customer portal authentication (fully separate from staff sign-in): portal users sign in with the organization's
 * portal key, email and password (Argon2id); session tokens start with `ylp_`, only their SHA-256 is stored and they
 * last 12 hours. Staff tokens cannot call portal endpoints and portal tokens cannot call staff endpoints. Every request
 * re-checks the session, the portal user's status, whether the organization's portal is enabled and whether the
 * contact still exists; organization, contact and account come only from the session. Failed sign-ins are limited
 * (10 per portal and email per 15 minutes) and unknown emails still verify a dummy hash. Staff create one-time
 * invitation links (token returned once, only its hash stored, valid 7 days); setting a password activates the user.
 */
import { randomBytes } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import { z } from 'zod';
import { PortalUserStatus } from '@/generated/prisma/enums';
import { audit, requestMeta, type RequestMeta } from './audit';
import { hashPassword, hashToken } from './auth';
import { prisma } from './db';
import { ApiError } from './errors';
import { publicRoute, type RouteParams } from './http';

/** 门户会话令牌前缀 / portal session token prefix */
export const PORTAL_TOKEN_PREFIX = 'ylp_';
/** 门户会话有效期 12 小时 / portal session lifetime: 12 hours */
export const PORTAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 邀请有效期 7 天 / invitation lifetime: 7 days */
export const PORTAL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 门户密码规则（与员工一致）/ portal password rule (same as staff) */
export const portalPassword = z.string().min(10).max(200);
/** 登录 / sign-in */
export const portalLoginSchema = z.strictObject({ portalKey: z.string().min(16).max(32), email: z.string().trim().max(254), password: z.string().min(1).max(200) });
/** 接受邀请 / accept an invitation */
export const portalAcceptSchema = z.strictObject({ token: z.string().min(20).max(200), password: portalPassword });
/** 修改密码 / change password */
export const portalPasswordSchema = z.strictObject({ currentPassword: z.string().min(1).max(200), newPassword: portalPassword });

/** 门户身份上下文 / portal identity context */
export interface PortalContext {
  portalUserId: string;
  organizationId: string;
  contactId: string;
  /** 联系人当前所属客户 / the contact's current account */
  accountId: string;
  name: string;
  email: string;
  sessionId: string;
  meta: RequestMeta;
}

// 登录失败限流 / sign-in failure limiter
const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
let dummyHash: Promise<string> | undefined;

/**
 * 清空门户登录限流状态（仅供测试）。
 * Reset the portal sign-in limiter (tests only).
 */
export function resetPortalLimiter(): void {
  failures.clear();
}

/** 新会话令牌 / a new session token */
const newToken = () => `${PORTAL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

/** 创建会话 / create a session */
async function createSession(portalUserId: string): Promise<string> {
  const token = newToken();
  await prisma.portalSession.create({ data: { portalUserId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS) } });
  return token;
}

/**
 * 门户登录。
 * Portal sign-in.
 * @returns 原始令牌（仅此一次）与门户用户 / the raw token (returned once) and the portal user
 */
export async function portalLogin(input: z.infer<typeof portalLoginSchema>, meta: RequestMeta) {
  const email = input.email.toLowerCase();
  const key = `${input.portalKey}:${email}`;
  const now = Date.now();
  const entry = failures.get(key);
  if (entry && entry.resetAt > now && entry.count >= MAX_FAILURES) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed attempts');
  const settings = await prisma.portalSettings.findUnique({ where: { portalKey: input.portalKey } });
  const user = settings?.isEnabled ? await prisma.portalUser.findUnique({ where: { organizationId_email: { organizationId: settings.organizationId, email } } }) : null;
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const ok = await verify(user?.passwordHash ?? (await dummyHash), input.password);
  if (!user || !ok || user.status !== PortalUserStatus.ACTIVE) {
    failures.set(key, { count: entry && entry.resetAt > now ? entry.count + 1 : 1, resetAt: entry && entry.resetAt > now ? entry.resetAt : now + WINDOW_MS });
    if (user) {
      await prisma.$transaction((tx) =>
        audit(tx, { organizationId: user.organizationId, actorId: null, action: 'portal.login_failed', entityType: 'portal', entityId: user.id, changes: { contactId: user.contactId, reason: ok ? 'not_active' : 'bad_password' }, meta }),
      );
    }
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  failures.delete(key);
  const token = await createSession(user.id);
  await prisma.$transaction(async (tx) => {
    await tx.portalUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit(tx, { organizationId: user.organizationId, actorId: null, action: 'portal.login', entityType: 'portal', entityId: user.id, changes: { contactId: user.contactId }, meta });
  });
  return { token };
}

/**
 * 接受邀请：设置密码、启用并登录（令牌一次性；旧会话失效）。
 * Accept an invitation: set the password, activate and sign in (one-time token; old sessions are revoked).
 */
export async function acceptInvite(input: z.infer<typeof portalAcceptSchema>, meta: RequestMeta) {
  const user = await prisma.portalUser.findUnique({ where: { inviteTokenHash: hashToken(input.token) } });
  const settings = user ? await prisma.portalSettings.findUnique({ where: { organizationId: user.organizationId } }) : null;
  if (!user || !user.inviteExpiresAt || user.inviteExpiresAt.getTime() <= Date.now() || user.status === PortalUserStatus.DISABLED || !settings?.isEnabled) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid or expired invitation', { token: ['invalid'] });
  }
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    // 条件更新：并发使用同一令牌时只成功一次 / conditional update: concurrent uses of one token succeed once
    const { count } = await tx.portalUser.updateMany({
      where: { id: user.id, inviteTokenHash: user.inviteTokenHash },
      data: { passwordHash, status: PortalUserStatus.ACTIVE, inviteTokenHash: null, inviteExpiresAt: null },
    });
    if (!count) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid or expired invitation', { token: ['invalid'] });
    await tx.portalSession.deleteMany({ where: { portalUserId: user.id } });
    await audit(tx, { organizationId: user.organizationId, actorId: null, action: 'portal.activate', entityType: 'portal', entityId: user.id, changes: { contactId: user.contactId }, meta });
  });
  return { token: await createSession(user.id), portalKey: settings.portalKey };
}

/** 从请求头取出门户令牌 / extract the portal token */
function portalBearer(req: Request): string | null {
  const match = /^Bearer (ylp_[A-Za-z0-9_-]{20,200})$/.exec(req.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

/**
 * 校验门户会话（每个请求）。
 * Verify the portal session (every request).
 * @throws ApiError 401 未登录、会话失效、用户停用、门户关闭或联系人已删除 / not signed in, expired, disabled, portal off or contact gone
 */
export async function authenticatePortal(req: Request): Promise<PortalContext> {
  const token = portalBearer(req);
  if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'Portal authentication required');
  const session = await prisma.portalSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { portalUser: { include: { contact: { select: { id: true, name: true, accountId: true } }, organization: { select: { portalSettings: { select: { isEnabled: true } } } } } } },
  });
  const user = session?.portalUser;
  if (!session || session.expiresAt.getTime() <= Date.now() || !user || user.status !== PortalUserStatus.ACTIVE || !user.organization.portalSettings?.isEnabled) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }
  return {
    portalUserId: user.id,
    organizationId: user.organizationId,
    contactId: user.contact.id,
    accountId: user.contact.accountId,
    name: user.contact.name,
    email: user.email,
    sessionId: session.id,
    meta: requestMeta(req),
  };
}

/** 门户路由处理器 / portal route handler */
type PortalHandler = (req: Request, ctx: PortalContext, route: RouteParams) => Promise<Response>;

/**
 * 包装门户路由：每个请求校验门户会话。
 * Wrap a portal route: every request verifies the portal session.
 */
export function portalRoute(handler: PortalHandler) {
  return publicRoute(async (req, route) => handler(req, await authenticatePortal(req), route));
}

/**
 * 退出门户（删除当前会话）。
 * Sign out of the portal (delete the current session).
 */
export async function portalLogout(ctx: PortalContext): Promise<void> {
  await prisma.portalSession.deleteMany({ where: { id: ctx.sessionId } });
}

/**
 * 修改门户密码（校验当前密码；其他会话失效）。
 * Change the portal password (checks the current one; other sessions are revoked).
 */
export async function changePortalPassword(ctx: PortalContext, input: z.infer<typeof portalPasswordSchema>): Promise<void> {
  const user = await prisma.portalUser.findUniqueOrThrow({ where: { id: ctx.portalUserId } });
  if (!user.passwordHash || !(await verify(user.passwordHash, input.currentPassword))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Current password is wrong', { currentPassword: ['wrong'] });
  }
  const passwordHash = await hashPassword(input.newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.portalUser.update({ where: { id: user.id }, data: { passwordHash } });
    await tx.portalSession.deleteMany({ where: { portalUserId: user.id, id: { not: ctx.sessionId } } });
    await audit(tx, { organizationId: user.organizationId, actorId: null, action: 'portal.password', entityType: 'portal', entityId: user.id, changes: { contactId: user.contactId }, meta: ctx.meta });
  });
}
