/**
 * 字段权限设置（设置 › 字段权限，需 user.manage）：按对象列出可限制的字段（标准字段 + 自定义字段）与各角色的访问级别，
 * 按角色整体保存。系统管理员不受限，不出现在设置中；自定义字段删除时其设置随之删除。修改写审计。
 * Field permission setup (Setup › Field permissions, user.manage): the restrictable fields of an entity (standard and
 * custom) with each role's access, saved per role as a whole. Administrators are never restricted and not listed;
 * a custom field's settings are removed with the field. Changes are audited.
 */
import { z } from 'zod';
import { CustomEntity, FieldAccess, UserRole } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { CUSTOM_PREFIX, RESTRICTABLE } from '../field-security';
import { requirePermission } from '../permissions';

/** 可设置的系统角色 / system roles that can be restricted */
const SYSTEM_ROLES = [UserRole.MANAGER, UserRole.SALES, UserRole.READONLY] as const;

/** 读取参数 / read query */
export const fieldPermissionQuerySchema = z.strictObject({ entity: z.enum(CustomEntity) });

/** 保存某个角色在某个对象上的设置（整体替换；未列出的字段可编辑）/ save one role's settings on an entity (replaces; unlisted = editable) */
export const fieldPermissionUpdateSchema = z
  .strictObject({
    entity: z.enum(CustomEntity),
    role: z.enum(SYSTEM_ROLES).optional(),
    customRoleId: z.uuid().optional(),
    rules: z.record(z.string().max(40), z.enum(['EDIT', FieldAccess.HIDDEN, FieldAccess.READ_ONLY])),
  })
  .refine((v) => (v.role === undefined) !== (v.customRoleId === undefined), { message: 'one_role', path: ['role'] });

/**
 * 对象的可限制字段、角色与当前设置。
 * Restrictable fields of an entity, the roles and the current settings.
 */
export async function getFieldPermissions(ctx: AuthContext, entity: CustomEntity) {
  requirePermission(ctx, 'user.manage');
  const [custom, roles, rows] = await prisma.$transaction([
    prisma.customField.findMany({ where: { organizationId: ctx.organizationId, entity }, select: { key: true, label: true, isActive: true, required: true }, orderBy: { position: 'asc' } }),
    prisma.customRole.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true, baseRole: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.fieldPermission.findMany({ where: { organizationId: ctx.organizationId, entity }, select: { field: true, role: true, customRoleId: true, access: true } }),
  ]);
  const rules: Record<string, Record<string, FieldAccess>> = {};
  for (const r of rows) (rules[r.role ?? r.customRoleId!] ??= {})[r.field] = r.access;
  return {
    fields: [
      ...RESTRICTABLE[entity].map((field) => ({ field, custom: false as const })),
      ...custom.map((c) => ({ field: CUSTOM_PREFIX + c.key, custom: true as const, label: c.label, isActive: c.isActive, required: c.required })),
    ],
    roles: [...SYSTEM_ROLES.map((role) => ({ key: role, role })), ...roles.map((r) => ({ key: r.id, customRoleId: r.id, name: r.name, baseRole: r.baseRole }))],
    rules,
  };
}

/**
 * 保存某个角色在某个对象上的字段设置；使用该角色的用户在下一个请求按新设置生效。
 * Save one role's field settings on an entity; its users get them on their next request.
 * @throws ApiError 400 未知字段 / unknown field；404 自定义角色不存在 / unknown custom role
 */
export async function updateFieldPermissions(ctx: AuthContext, input: z.infer<typeof fieldPermissionUpdateSchema>) {
  requirePermission(ctx, 'user.manage');
  const { entity, role, customRoleId } = input;
  let roleName: string | null = null;
  if (customRoleId) {
    const r = await prisma.customRole.findFirst({ where: { id: customRoleId, organizationId: ctx.organizationId }, select: { name: true } });
    if (!r) throw notFound();
    roleName = r.name;
  }
  const customLabels = new Map((await prisma.customField.findMany({ where: { organizationId: ctx.organizationId, entity }, select: { key: true, label: true } })).map((c) => [CUSTOM_PREFIX + c.key, c.label]));
  const keys = new Set(customLabels.keys());
  const errors: Record<string, string[]> = {};
  for (const field of Object.keys(input.rules)) if (!RESTRICTABLE[entity].includes(field) && !keys.has(field)) errors[`rules.${field}`] = ['unknown_field'];
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown fields', errors);
  const next = Object.entries(input.rules).filter((e): e is [string, FieldAccess] => e[1] !== 'EDIT');
  const who = customRoleId ? { customRoleId } : { role: role!, customRoleId: null };

  return prisma.$transaction(async (tx) => {
    // 同一角色同一对象的保存串行，避免并发保存互相覆盖出错 / saves of one role and entity are serialised
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`fieldperm:${ctx.organizationId}:${entity}:${customRoleId ?? role}`}, 0))`;
    const before = await tx.fieldPermission.findMany({ where: { organizationId: ctx.organizationId, entity, ...who }, select: { field: true, access: true } });
    await tx.fieldPermission.deleteMany({ where: { organizationId: ctx.organizationId, entity, ...who } });
    if (next.length) await tx.fieldPermission.createMany({ data: next.map(([field, access]) => ({ organizationId: ctx.organizationId, entity, field, access, ...(customRoleId ? { customRoleId } : { role }) })) });
    const was = new Map(before.map((b) => [b.field, b.access as string]));
    const now = new Map<string, string>(next);
    const changed: Record<string, [string, string]> = {};
    for (const f of new Set([...was.keys(), ...now.keys()])) {
      const a = was.get(f) ?? 'EDIT';
      const b = now.get(f) ?? 'EDIT';
      if (a !== b) changed[f] = [a, b];
    }
    if (Object.keys(changed).length) {
      await audit(tx, { ...by(ctx), action: 'fieldpermission.update', entityType: 'fieldpermission', entityId: customRoleId ?? null, changes: { entity, ...(customRoleId ? { customRole: roleName } : { role }), fields: changed, labels: Object.fromEntries(Object.keys(changed).filter((f) => customLabels.has(f)).map((f) => [f, customLabels.get(f)])) } });
    }
    return { entity, ...(customRoleId ? { customRoleId } : { role }), rules: Object.fromEntries(next) };
  });
}
