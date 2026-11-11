/**
 * 演示账号一键登录。仅当环境变量 DEMO_LOGIN_ENABLED=1 时可用（默认关闭，生产环境不得开启）；
 * 只允许登录 is_demo=true 且启用中的账号，不经过、不暴露任何密码。
 * One-click demo login. Available only when DEMO_LOGIN_ENABLED=1 (off by default; never in production).
 * Only active users with is_demo=true can be used; no password is involved or exposed.
 */
import { randomBytes } from 'node:crypto';
import { audit, type RequestMeta } from './audit';
import { hashToken, SESSION_TTL_MS } from './auth';
import { prisma } from './db';
import { ApiError, notFound } from './errors';

/** 是否开启演示登录 / Whether demo login is enabled */
export const demoLoginEnabled = (): boolean => process.env.DEMO_LOGIN_ENABLED === '1';

/**
 * 演示账号列表（不含密码）。未开启时视为不存在。
 * Demo accounts (no passwords). 404 when disabled.
 */
export async function listDemoAccounts() {
  if (!demoLoginEnabled()) throw notFound();
  const users = await prisma.user.findMany({
    where: { isDemo: true, isActive: true },
    select: { id: true, name: true, email: true, role: true, organization: { select: { name: true } } },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  return users.map(({ organization, ...u }) => ({ ...u, organizationName: organization.name }));
}

/**
 * 以演示账号登录，返回会话令牌（与正常登录相同，仅保存哈希）。
 * Sign in as a demo account; returns a session token (only its hash is stored, as with normal login).
 */
export async function demoLogin(userId: string, meta?: RequestMeta) {
  if (!demoLoginEnabled()) throw notFound();
  const user = await prisma.user.findFirst({ where: { id: userId, isDemo: true, isActive: true } });
  if (!user) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Not a demo account');
  const token = randomBytes(32).toString('base64url');
  await prisma.$transaction(async (tx) => {
    await tx.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    await audit(tx, { organizationId: user.organizationId, actorId: user.id, action: 'auth.demo_login', entityType: 'auth', entityId: user.id, meta });
  });
  return { token, user: { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId } };
}
