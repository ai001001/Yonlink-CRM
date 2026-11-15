/**
 * 个人设置：查看自己的账号信息、修改显示名称、修改密码、查看最近登录记录、查看并退出其他设备上的登录。
 * - 修改密码须提供当前密码；新密码沿用用户密码规则且不能与当前密码相同；成功后其他会话全部失效，当前会话保留。
 * - 当前密码错误按用户限流（15 分钟内最多 5 次）并写审计；演示账号不能设置密码（演示账号仅能免密登录）。
 * - 密码、密码哈希永不写入审计或返回；登录记录只读取本人的认证审计。
 * Profile: own account details, display name, password change, recent sign-ins, and signing out other devices.
 * Changing the password requires the current one; the new one follows the user password rule and must differ; other
 * sessions are revoked and the current one is kept. Wrong current passwords are rate-limited per user (5 per 15 min)
 * and audited; demo accounts cannot set a password. Passwords and hashes are never audited or returned.
 */
import { verify } from '@node-rs/argon2';
import { z } from 'zod';
import { audit, by } from '../audit';
import { hashPassword, type AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { requiredText } from '../validation';
import { passwordRule } from './users';

/** 修改显示名称 / Update the display name */
export const profileUpdateSchema = z.strictObject({ name: requiredText(100) });
/** 修改密码 / Change the password */
export const passwordChangeSchema = z.strictObject({ currentPassword: z.string().min(1).max(200), newPassword: passwordRule });

/** 登录记录条数 / sign-in entries shown */
export const LOGIN_HISTORY = 20;
/** 认证相关操作 / authentication actions shown in the history */
const AUTH_ACTIONS = ['auth.login', 'auth.demo_login', 'auth.login_failed', 'auth.logout', 'auth.logout_others'];

// 当前密码错误限流：同一用户 15 分钟内最多 5 次 / wrong current passwords: 5 per user per 15 minutes
const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * 清空限流状态（仅供测试）。
 * Reset the limiter (tests only).
 */
export function resetPasswordChangeLimiter(): void {
  failures.clear();
}

/**
 * 我的个人信息、会话与最近登录记录。
 * My profile, sessions and recent sign-ins.
 */
export async function getProfile(ctx: AuthContext) {
  const [user, sessions, history] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { id: true, name: true, email: true, role: true, isDemo: true, createdAt: true, organization: { select: { id: true, name: true } } },
    }),
    prisma.session.findMany({ where: { userId: ctx.userId, expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, expiresAt: true }, orderBy: { createdAt: 'desc' } }),
    prisma.auditLog.findMany({
      where: { organizationId: ctx.organizationId, entityType: 'auth', entityId: ctx.userId, action: { in: AUTH_ACTIONS } },
      select: { id: true, action: true, ip: true, userAgent: true, changes: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: LOGIN_HISTORY,
    }),
  ]);
  return {
    user,
    // 会话只返回 ID 与时间，不返回令牌哈希 / sessions expose their id and times, never the token hash
    sessions: sessions.map((s) => ({ id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt, current: s.id === ctx.sessionId })),
    loginHistory: history.map((h) => ({
      id: h.id,
      action: h.action,
      ip: h.ip,
      userAgent: h.userAgent,
      reason: (h.changes as { reason?: string } | null)?.reason ?? null,
      createdAt: h.createdAt,
    })),
  };
}

/**
 * 修改自己的显示名称（写审计）。
 * Change my display name (audited).
 */
export async function updateProfile(ctx: AuthContext, input: z.infer<typeof profileUpdateSchema>) {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { name: true } });
  if (current.name !== input.name) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: ctx.userId }, data: { name: input.name } });
      await audit(tx, { ...by(ctx), action: 'user.update', entityType: 'user', entityId: ctx.userId, changes: { fields: { name: [current.name, input.name] }, via: 'user.profile' } });
    });
  }
  return getProfile(ctx);
}

/**
 * 修改自己的密码：校验当前密码，成功后其他会话失效（当前会话保留）。
 * Change my password: verify the current one; on success other sessions are revoked (the current one is kept).
 */
export async function changePassword(ctx: AuthContext, input: z.infer<typeof passwordChangeSchema>): Promise<{ revokedSessions: number }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { passwordHash: true, isDemo: true } });
  if (user.isDemo) throw new ApiError(403, 'FORBIDDEN', 'Demo accounts cannot set a password', { currentPassword: ['demo'] });
  const now = Date.now();
  const entry = failures.get(ctx.userId);
  if (entry && entry.resetAt > now && entry.count >= MAX_FAILURES) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed attempts');
  if (!(await verify(user.passwordHash, input.currentPassword))) {
    failures.set(ctx.userId, { count: entry && entry.resetAt > now ? entry.count + 1 : 1, resetAt: entry && entry.resetAt > now ? entry.resetAt : now + WINDOW_MS });
    await prisma.$transaction((tx) => audit(tx, { ...by(ctx), action: 'user.change_password_failed', entityType: 'user', entityId: ctx.userId, changes: { reason: 'bad_password' } }));
    throw new ApiError(400, 'VALIDATION_ERROR', 'Current password is incorrect', { currentPassword: ['incorrect'] });
  }
  failures.delete(ctx.userId);
  if (input.newPassword === input.currentPassword) throw new ApiError(400, 'VALIDATION_ERROR', 'New password must differ', { newPassword: ['same'] });
  const passwordHash = await hashPassword(input.newPassword);
  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: ctx.userId }, data: { passwordHash } });
    const { count } = await tx.session.deleteMany({ where: { userId: ctx.userId, ...(ctx.sessionId ? { id: { not: ctx.sessionId } } : {}) } });
    await audit(tx, { ...by(ctx), action: 'user.change_password', entityType: 'user', entityId: ctx.userId, changes: { revokedSessions: count } });
    return { revokedSessions: count };
  });
}

/**
 * 退出其他所有设备上的登录（保留当前会话，写审计）。
 * Sign out of all other devices (the current session is kept; audited).
 */
export async function revokeOtherSessions(ctx: AuthContext): Promise<{ revokedSessions: number }> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.session.deleteMany({ where: { userId: ctx.userId, ...(ctx.sessionId ? { id: { not: ctx.sessionId } } : {}) } });
    await audit(tx, { ...by(ctx), action: 'auth.logout_others', entityType: 'auth', entityId: ctx.userId, changes: { revokedSessions: count } });
    return { revokedSessions: count };
  });
}
