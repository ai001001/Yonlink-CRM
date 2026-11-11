/**
 * 用户管理（仅系统管理员）。保证组织内始终至少有一名启用中的系统管理员。
 * User management (admins only). The organization always keeps at least one active admin.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { UserRole } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import { hashPassword, type AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { requiredText } from '../validation';

const password = z.string().min(10).max(200);

/** 新建用户 / Create user */
export const userCreateSchema = z.strictObject({
  name: requiredText(100),
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  role: z.enum(UserRole),
  password,
});

/** 更新用户（不含密码）/ Update user (no password) */
export const userUpdateSchema = z.strictObject({ name: requiredText(100), role: z.enum(UserRole), isActive: z.boolean() }).partial();

/** 重置密码 / Reset password */
export const passwordResetSchema = z.strictObject({ password });

const select = { id: true, name: true, email: true, role: true, isActive: true, isDemo: true, createdAt: true } satisfies Prisma.UserSelect;

/**
 * 本组织全部用户（含停用）。
 * All users of the organization, including inactive ones.
 */
export async function listUsers(ctx: AuthContext) {
  requirePermission(ctx, 'user.manage');
  return prisma.user.findMany({ where: { organizationId: ctx.organizationId }, select, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
}

/**
 * 新建用户（邮箱全局唯一，重复返回 409）。
 * Create a user (email is globally unique; duplicates yield 409).
 */
export async function createUser(ctx: AuthContext, input: z.infer<typeof userCreateSchema>) {
  requirePermission(ctx, 'user.manage');
  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { organizationId: ctx.organizationId, name: input.name, email: input.email, role: input.role, passwordHash },
      select,
    });
    await audit(tx, { ...by(ctx), action: 'user.create', entityType: 'user', entityId: user.id, changes: { after: snapshot('user', user) } });
    return user;
  });
}

/**
 * 读取本组织用户，不存在时 404。
 * Load a user of the organization or throw 404.
 */
async function requireUser(ctx: AuthContext, id: string) {
  const user = await prisma.user.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!user) throw notFound();
  return user;
}

/**
 * 修改姓名、角色或启用状态。不能修改自己的角色或停用自己；不能让组织失去最后一名启用中的管理员。
 * Change name, role or active state. Users cannot change their own role or deactivate themselves,
 * and the organization cannot lose its last active admin.
 */
export async function updateUser(ctx: AuthContext, id: string, input: z.infer<typeof userUpdateSchema>) {
  requirePermission(ctx, 'user.manage');
  const current = await requireUser(ctx, id);
  if (id === ctx.userId && ((input.role !== undefined && input.role !== current.role) || input.isActive === false)) {
    throw new ApiError(409, 'CONFLICT', 'Cannot change own role or deactivate yourself', { user: ['self'] });
  }
  return prisma.$transaction(async (tx) => {
    // 锁定本组织启用中的管理员行，防止两名管理员并发互相降级后无人管理
    // lock active admin rows so two admins demoting each other concurrently cannot leave none
    await tx.$queryRaw`SELECT id FROM users WHERE organization_id = ${ctx.organizationId}::uuid AND role = 'ADMIN' AND is_active FOR UPDATE`;
    const user = await tx.user.update({ where: { id }, data: input, select });
    const losesAdmin = current.role === 'ADMIN' && current.isActive && (user.role !== 'ADMIN' || !user.isActive);
    if (losesAdmin) {
      const admins = await tx.user.count({ where: { organizationId: ctx.organizationId, role: 'ADMIN', isActive: true } });
      if (admins === 0) throw new ApiError(409, 'CONFLICT', 'At least one active admin is required', { role: ['last-admin'] });
    }
    // 停用即注销其全部会话（每个请求也会检查启用状态）/ deactivation revokes sessions (requests also check isActive)
    if (!user.isActive) await tx.session.deleteMany({ where: { userId: id } });
    const fields = diff('user', current, user);
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'user.update', entityType: 'user', entityId: id, changes: { fields } });
    }
    return user;
  });
}

/**
 * 重置密码并注销该用户全部会话；审计中不记录密码。
 * Reset a password and revoke all sessions of the user; the password is never audited.
 */
export async function resetPassword(ctx: AuthContext, id: string, input: z.infer<typeof passwordResetSchema>): Promise<void> {
  requirePermission(ctx, 'user.manage');
  await requireUser(ctx, id);
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: id } });
    await audit(tx, { ...by(ctx), action: 'user.reset_password', entityType: 'user', entityId: id });
  });
}
