/**
 * 自定义角色（对标 Zoho 的 Profiles）：管理员基于系统角色（经理、销售、只读）建立权限集合并分配给用户。
 * - 权限从可授予目录中选择；“用户管理”“集成管理”只属于系统管理员，不能授予（数据库约束兜底）。
 * - 基础角色建立后不可改（决定审批层级与流程蓝图中的角色归属）；名称组织内不区分大小写唯一；每组织最多 30 个。
 * - 有用户使用的角色不能删除；权限修改与撤销在下一个请求立即生效（每个请求从数据库读取）。
 * - 维护需 user.manage（系统管理员），写审计；系统角色的权限只读展示。
 * Custom roles (cf. Zoho profiles): admins build permission sets on a system role (manager, sales, read-only) and assign
 * them to users. Permissions come from the grantable catalogue; user and integration management stay with system
 * administrators (enforced by a database check). The base role is fixed after creation (it decides approval levels and
 * blueprint roles); names are unique per organization; at most 30. Roles in use cannot be deleted; changes and
 * revocations apply on the next request (read from the database every time). Maintenance needs user.manage (admins)
 * and is audited; system roles are shown read-only.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { UserRole } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { ADMIN_ONLY, GRANTABLE, requirePermission, ROLE_PERMISSIONS, type Permission } from '../permissions';
import { optionalText, requiredText } from '../validation';

/** 每组织最多自定义角色数 / max custom roles per organization */
export const MAX_ROLES = 30;

const permissionList = z
  .array(z.string().max(40))
  .max(GRANTABLE.length)
  .superRefine((v, ctx) => {
    v.forEach((p, i) => {
      if (!GRANTABLE.includes(p as Permission)) ctx.addIssue({ code: 'custom', path: [i], message: ADMIN_ONLY.includes(p as Permission) ? 'admin_only' : 'unknown_permission' });
    });
    if (new Set(v).size !== v.length) ctx.addIssue({ code: 'custom', message: 'duplicate' });
  });

/** 新建 / create */
export const roleCreateSchema = z.strictObject({
  name: requiredText(50),
  description: optionalText(500),
  baseRole: z.enum(UserRole).exclude([UserRole.ADMIN]),
  permissions: permissionList,
});
/** 修改（基础角色不可改）/ update (the base role is fixed) */
export const roleUpdateSchema = z.strictObject({ name: requiredText(50), description: optionalText(500), permissions: permissionList }).partial();

const select = {
  id: true,
  name: true,
  description: true,
  baseRole: true,
  permissions: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { users: true } },
} satisfies Prisma.CustomRoleSelect;

/** 审计快照 / audit snapshot */
const snap = (r: { name: string; description: string | null; baseRole: string; permissions: string[] }) => ({ name: r.name, description: r.description, baseRole: r.baseRole, permissions: [...r.permissions].sort() });

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Role name already exists', { name: ['taken'] });
  throw err;
}

/**
 * 系统角色与自定义角色，以及可授予的权限目录（需 user.manage）。
 * System and custom roles plus the grantable catalogue (user.manage).
 */
export async function listRoles(ctx: AuthContext) {
  requirePermission(ctx, 'user.manage');
  const custom = await prisma.customRole.findMany({ where: { organizationId: ctx.organizationId }, select, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return {
    system: (Object.keys(ROLE_PERMISSIONS) as UserRole[]).map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] })),
    custom,
    grantable: GRANTABLE,
    adminOnly: ADMIN_ONLY,
  };
}

/**
 * 新建自定义角色（组织内串行判断上限）。
 * Create a custom role (the cap is checked under a per-organization lock).
 */
export async function createRole(ctx: AuthContext, input: z.infer<typeof roleCreateSchema>) {
  requirePermission(ctx, 'user.manage');
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`role:${ctx.organizationId}`}, 0))`;
      if ((await tx.customRole.count({ where: { organizationId: ctx.organizationId } })) >= MAX_ROLES) throw new ApiError(409, 'CONFLICT', 'Too many roles', { name: ['limit_reached'] });
      const r = await tx.customRole.create({ data: { ...input, organizationId: ctx.organizationId }, select });
      await audit(tx, { ...by(ctx), action: 'role.create', entityType: 'role', entityId: r.id, changes: { after: snap(r) } });
      return r;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 修改自定义角色（名称、说明、权限）；使用该角色的用户在下一个请求按新权限生效。
 * Update a custom role (name, description, permissions); its users get the new permissions on their next request.
 */
export async function updateRole(ctx: AuthContext, id: string, input: z.infer<typeof roleUpdateSchema>) {
  requirePermission(ctx, 'user.manage');
  const current = await prisma.customRole.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  try {
    return await prisma.$transaction(async (tx) => {
      const r = await tx.customRole.update({ where: { id }, data: input, select });
      const before = snap(current);
      const after = snap(r);
      const fields = Object.fromEntries((Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, [before[k], after[k]]]));
      if (Object.keys(fields).length) {
        const added = after.permissions.filter((p) => !before.permissions.includes(p));
        const removed = before.permissions.filter((p) => !after.permissions.includes(p));
        await audit(tx, { ...by(ctx), action: 'role.update', entityType: 'role', entityId: id, changes: { name: r.name, fields, added, removed, users: r._count.users } });
      }
      return r;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除自定义角色；有用户使用时 409（数据库外键兜底）。
 * Delete a custom role; 409 while users have it (the foreign key backs this up).
 */
export async function deleteRole(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'user.manage');
  const current = await prisma.customRole.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  if (current._count.users) throw new ApiError(409, 'CONFLICT', 'The role is assigned to users', { role: ['in_use'] });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.customRole.delete({ where: { id } });
      await audit(tx, { ...by(ctx), action: 'role.delete', entityType: 'role', entityId: id, changes: { before: snap(current) } });
    });
  } catch (err) {
    // 并发分配后外键拒绝删除 / a concurrent assignment makes the foreign key refuse the delete
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2003' || err.code === 'P2014')) throw new ApiError(409, 'CONFLICT', 'The role is assigned to users', { role: ['in_use'] });
    throw err;
  }
}
