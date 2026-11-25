/**
 * 自定义模块（对标 Zoho Custom Modules）：管理员新建记录类型（如“合同”“设备”），为其添加字段，各用户像使用内置
 * 模块一样新建、查看、编辑、删除记录。
 * - 模块：名称（组织内不区分大小写唯一）、说明、启用；每组织最多 10 个。停用的模块不出现在导航中，记录只读；
 *   有记录的模块不能删除（先删除记录或停用）。维护需 customfield.manage（管理员）并写审计；所有用户可读取定义。
 * - 字段：类型与自定义字段相同（单行/多行文本、数字、日期、下拉、勾选、网址、邮箱），每个模块最多 30 个；字段键由
 *   服务端生成且不变；停用字段不显示、不能填写，已有值保留；删除字段同时清除各记录中的值。
 * - 记录：名称（必填）、负责人、关联客户（可选，客户删除时清空）与各字段的值（请求中为 custom）。可见范围与编辑
 *   权限同内置记录：没有查看全部权限时只看自己负责的；编辑需负责人或编辑全部权限；删除需删除权限；关联的客户必须
 *   对当前用户可见。新建、修改、删除写审计（文本类字段值脱敏）。
 * - 不做：导入导出、工作流、报表、查重、回收站（删除直接生效）、自定义模块之间的关联。
 * Custom modules (cf. Zoho Custom Modules): admins define record types (e.g. contracts or equipment) and their fields;
 * users create, view, edit and delete records like built-in modules. Modules: unique name per organization
 * (case-insensitive), description, active flag; at most 10. Inactive modules leave the navigation and their records
 * become read-only; modules with records cannot be deleted. Maintenance needs customfield.manage (admins) and is
 * audited; everyone can read definitions. Fields: the custom field types, at most 30 per module, immutable
 * server-generated keys; inactive fields are hidden and read-only; deleting a field clears its values. Records: a
 * required name, owner, optional related account (cleared when the account is deleted) and field values (`custom` in
 * requests). Visibility and edit rights follow built-in records; the related account must be visible to the user.
 * Writes are audited with text-like values redacted. Not included: import/export, workflows, reports, duplicates, the
 * recycle bin (deletes are immediate) and links between custom modules.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { CustomFieldType } from '@/generated/prisma/enums';
import { audit, by, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, can, requirePermission, visible } from '../permissions';
import { containsText, listQuery, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';
import { checkFieldDef, customDiff, customFieldUpdateSchema, customInput, fieldOptions, mergeCustom } from './custom-fields';

/** 每组织最多模块数 / max modules per organization */
export const MAX_MODULES = 10;
/** 每个模块最多字段数 / max fields per module */
export const MAX_MODULE_FIELDS = 30;

/** 新建模块 / create a module */
export const moduleCreateSchema = z.strictObject({ name: requiredText(50), description: optionalText(500) });
/** 修改模块 / update a module */
export const moduleUpdateSchema = z.strictObject({ name: requiredText(50), description: optionalText(500), isActive: z.boolean() }).partial();
/** 模块列表（active=true 只返回启用的）/ module list (active=true returns active ones only) */
export const moduleListSchema = z.strictObject({ active: z.literal('true').optional() });
/** 新建字段 / create a field */
export const moduleFieldCreateSchema = z
  .strictObject({ label: requiredText(50), type: z.enum(CustomFieldType), options: fieldOptions.default([]), required: z.boolean().default(false) })
  .superRefine(checkFieldDef);
/** 修改字段（类型不可改）/ update a field (the type is fixed) */
export const moduleFieldUpdateSchema = customFieldUpdateSchema;

const recordFields = { name: requiredText(200), ownerId: optionalUuid.optional(), accountId: optionalUuid.optional(), custom: customInput };
/** 新建记录 / create a record */
export const recordCreateSchema = z.strictObject({ moduleId: z.uuid(), ...recordFields });
/** 修改记录 / update a record */
export const recordUpdateSchema = z.strictObject(recordFields).partial();
/** 记录列表：按模块，或按关联客户（跨模块）/ record list by module, or by related account across modules */
export const recordListSchema = listQuery
  .extend({ moduleId: z.uuid().optional(), accountId: z.uuid().optional(), ownerId: z.uuid().optional() })
  .refine((v) => v.moduleId || v.accountId, { message: 'moduleId or accountId is required', path: ['moduleId'] });

const moduleSelect = { id: true, name: true, description: true, isActive: true, position: true, createdAt: true, updatedAt: true } satisfies Prisma.CustomModuleSelect;
const fieldSelect = { id: true, moduleId: true, key: true, label: true, type: true, options: true, required: true, isActive: true, position: true } satisfies Prisma.CustomModuleFieldSelect;
const recordInclude = {
  owner: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  module: { select: { id: true, name: true, isActive: true } },
} satisfies Prisma.CustomRecordInclude;

/** 名称或字段名重复 / duplicate module name or field label */
function taken(err: unknown, field: 'name' | 'label'): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Name already exists', { [field]: ['taken'] });
  throw err;
}

/** 模块审计快照 / module audit snapshot */
const moduleSnap = (m: { name: string; description: string | null; isActive: boolean }) => ({ name: m.name, description: m.description, isActive: m.isActive });

/**
 * 模块列表（按顺序）；管理员另含字段数与记录数。
 * Modules in order; admins also get field and record counts.
 */
export async function listModules(ctx: AuthContext, query: z.infer<typeof moduleListSchema>) {
  const where = { organizationId: ctx.organizationId, ...(query.active ? { isActive: true } : {}) };
  const orderBy = [{ position: 'asc' as const }, { createdAt: 'asc' as const }];
  if (can(ctx, 'customfield.manage')) {
    return { items: await prisma.customModule.findMany({ where, select: { ...moduleSelect, _count: { select: { fields: true, records: true } } }, orderBy }) };
  }
  return { items: await prisma.customModule.findMany({ where, select: moduleSelect, orderBy }) };
}

/**
 * 模块详情（含全部字段定义，按顺序）。
 * A module with all its field definitions in order.
 */
export async function getModule(ctx: AuthContext, id: string) {
  const m = await prisma.customModule.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { ...moduleSelect, fields: { select: fieldSelect, orderBy: { position: 'asc' } } } });
  if (!m) throw notFound();
  return m;
}

/**
 * 新建模块（组织内串行判断上限与顺序）。
 * Create a module (cap and position under a per-organization lock).
 */
export async function createModule(ctx: AuthContext, input: z.infer<typeof moduleCreateSchema>) {
  requirePermission(ctx, 'customfield.manage');
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`module:${ctx.organizationId}`}, 0))`;
      if ((await tx.customModule.count({ where: { organizationId: ctx.organizationId } })) >= MAX_MODULES) {
        throw new ApiError(409, 'CONFLICT', 'Too many modules', { name: ['limit_reached'] });
      }
      const last = await tx.customModule.aggregate({ where: { organizationId: ctx.organizationId }, _max: { position: true } });
      const m = await tx.customModule.create({
        data: { ...input, organizationId: ctx.organizationId, createdById: ctx.userId, position: (last._max.position ?? -1) + 1 },
        select: moduleSelect,
      });
      await audit(tx, { ...by(ctx), action: 'module.create', entityType: 'module', entityId: m.id, changes: { after: moduleSnap(m) } });
      return m;
    });
  } catch (err) {
    taken(err, 'name');
  }
}

/**
 * 修改模块（名称、说明、启停）。
 * Update a module (name, description, active).
 */
export async function updateModule(ctx: AuthContext, id: string, input: z.infer<typeof moduleUpdateSchema>) {
  requirePermission(ctx, 'customfield.manage');
  const current = await prisma.customModule.findFirst({ where: { id, organizationId: ctx.organizationId }, select: moduleSelect });
  if (!current) throw notFound();
  try {
    return await prisma.$transaction(async (tx) => {
      const m = await tx.customModule.update({ where: { id }, data: input, select: moduleSelect });
      const before = moduleSnap(current);
      const after = moduleSnap(m);
      const fields = Object.fromEntries((Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]).map((k) => [k, [before[k], after[k]]]));
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'module.update', entityType: 'module', entityId: id, changes: { name: m.name, fields } });
      return m;
    });
  } catch (err) {
    taken(err, 'name');
  }
}

/**
 * 删除模块（连同字段）；有记录时 409。
 * Delete a module with its fields; 409 while it has records.
 */
export async function deleteModule(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'customfield.manage');
  await prisma.$transaction(async (tx) => {
    // 锁住模块行，避免同时新建记录 / lock the module row against concurrent record creation
    const rows = await tx.$queryRaw<{ name: string; description: string | null; is_active: boolean }[]>`
      SELECT name, description, is_active FROM custom_modules WHERE id = ${id}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r) throw notFound();
    const records = await tx.customRecord.count({ where: { organizationId: ctx.organizationId, moduleId: id } });
    if (records) throw new ApiError(409, 'CONFLICT', 'The module has records', { module: ['has_records'] });
    await tx.customModule.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'module.delete', entityType: 'module', entityId: id, changes: { before: { name: r.name, description: r.description, isActive: r.is_active } } });
  });
}

/**
 * 读取本组织的模块，不存在时 404。
 * Load a module of this organization or throw 404.
 */
async function requireModule(ctx: AuthContext, id: string) {
  const m = await prisma.customModule.findFirst({ where: { id, organizationId: ctx.organizationId }, select: moduleSelect });
  if (!m) throw notFound();
  return m;
}

/**
 * 模块的字段（按顺序，含停用的）。
 * A module's fields in order (inactive ones included).
 */
export async function listModuleFields(ctx: AuthContext, moduleId: string) {
  await requireModule(ctx, moduleId);
  return { items: await prisma.customModuleField.findMany({ where: { organizationId: ctx.organizationId, moduleId }, select: fieldSelect, orderBy: { position: 'asc' } }) };
}

/**
 * 新建字段（同一模块串行判断上限与顺序）。
 * Create a field (cap and position under a per-module lock).
 */
export async function createModuleField(ctx: AuthContext, moduleId: string, input: z.infer<typeof moduleFieldCreateSchema>) {
  requirePermission(ctx, 'customfield.manage');
  const m = await requireModule(ctx, moduleId);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`modulefield:${moduleId}`}, 0))`;
      if ((await tx.customModuleField.count({ where: { moduleId } })) >= MAX_MODULE_FIELDS) throw new ApiError(409, 'CONFLICT', 'Too many fields', { label: ['limit_reached'] });
      const last = await tx.customModuleField.aggregate({ where: { moduleId }, _max: { position: true } });
      const key = `cf_${randomBytes(4).toString('hex')}`;
      const f = await tx.customModuleField.create({ data: { ...input, organizationId: ctx.organizationId, moduleId, key, position: (last._max.position ?? -1) + 1 }, select: fieldSelect });
      await audit(tx, { ...by(ctx), action: 'module.field_create', entityType: 'module', entityId: moduleId, changes: { name: m.name, field: { key, label: f.label, type: f.type, options: f.options, required: f.required } } });
      return f;
    });
  } catch (err) {
    taken(err, 'label');
  }
}

/**
 * 读取本组织的字段（含所属模块名称），不存在时 404。
 * Load a field of this organization (with its module name) or throw 404.
 */
async function requireField(ctx: AuthContext, id: string) {
  const f = await prisma.customModuleField.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { ...fieldSelect, module: { select: { name: true } } } });
  if (!f) throw notFound();
  return f;
}

/**
 * 修改字段（名称、选项、必填、启停）。
 * Update a field (label, options, required, active).
 */
export async function updateModuleField(ctx: AuthContext, id: string, input: z.infer<typeof moduleFieldUpdateSchema>) {
  requirePermission(ctx, 'customfield.manage');
  const current = await requireField(ctx, id);
  if (input.options !== undefined && current.type !== CustomFieldType.PICKLIST) throw new ApiError(400, 'VALIDATION_ERROR', 'Only picklists have options', { options: ['not_allowed'] });
  if (input.options !== undefined && !input.options.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Picklists need options', { options: ['required'] });
  if (input.required && current.type === CustomFieldType.CHECKBOX) throw new ApiError(400, 'VALIDATION_ERROR', 'Checkboxes cannot be required', { required: ['not_allowed'] });
  try {
    return await prisma.$transaction(async (tx) => {
      const f = await tx.customModuleField.update({ where: { id }, data: input, select: fieldSelect });
      const fields = Object.fromEntries(
        (['label', 'options', 'required', 'isActive'] as const).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(f[k])).map((k) => [k, [current[k], f[k]]]),
      );
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'module.field_update', entityType: 'module', entityId: current.moduleId, changes: { name: current.module.name, key: current.key, fields } });
      return f;
    });
  } catch (err) {
    taken(err, 'label');
  }
}

/**
 * 删除字段：同时清除该模块各记录中的值。
 * Delete a field and clear its values from the module's records.
 */
export async function deleteModuleField(ctx: AuthContext, id: string): Promise<{ cleared: number }> {
  requirePermission(ctx, 'customfield.manage');
  const current = await requireField(ctx, id);
  return prisma.$transaction(async (tx) => {
    await tx.customModuleField.delete({ where: { id } });
    const cleared = await tx.$executeRaw`
      UPDATE custom_records SET "values" = "values" - ${current.key}, updated_at = now()
      WHERE organization_id = ${ctx.organizationId}::uuid AND module_id = ${current.moduleId}::uuid AND "values" ? ${current.key}`;
    await audit(tx, {
      ...by(ctx),
      action: 'module.field_delete',
      entityType: 'module',
      entityId: current.moduleId,
      changes: { name: current.module.name, field: { key: current.key, label: current.label, type: current.type }, cleared },
    });
    return { cleared };
  });
}

/**
 * 记录可见范围（同内置记录：没有查看全部权限时只看自己负责的）。
 * Record visibility (as built-in records: own records only without read-all).
 */
const recordScope = (ctx: AuthContext): Prisma.CustomRecordWhereInput => visible(ctx);

/**
 * 关联的客户必须对当前用户可见，否则 400。
 * The related account must be visible to the user, else 400.
 */
async function assertAccount(ctx: AuthContext, accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  if (!(await prisma.account.count({ where: { id: accountId, ...visible(ctx) } }))) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid account', { accountId: ['not_found'] });
}

/** 停用的模块不能写入 / inactive modules are read-only */
function assertActive(m: { isActive: boolean }): void {
  if (!m.isActive) throw new ApiError(409, 'CONFLICT', 'The module is inactive', { module: ['inactive'] });
}

/**
 * 分页搜索记录（名称）；按模块，或按关联客户跨模块（只含启用的模块）。
 * Search records by name, paginated; by module, or across active modules by related account.
 */
export async function listRecords(ctx: AuthContext, query: z.infer<typeof recordListSchema>): Promise<Page<unknown>> {
  if (query.moduleId) await requireModule(ctx, query.moduleId);
  const where: Prisma.CustomRecordWhereInput = {
    AND: [
      recordScope(ctx),
      { moduleId: query.moduleId, accountId: query.accountId, ownerId: query.ownerId },
      query.moduleId ? {} : { module: { isActive: true } },
      query.q ? { name: containsText(query.q) } : {},
    ],
  };
  const [items, total] = await prisma.$transaction([
    prisma.customRecord.findMany({ where, include: recordInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.customRecord.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 记录详情；不可见时 404。
 * Record detail; 404 when not visible.
 */
export async function getRecord(ctx: AuthContext, id: string) {
  const r = await prisma.customRecord.findFirst({ where: { AND: [{ id }, recordScope(ctx)] }, include: recordInclude });
  if (!r) throw notFound();
  return r;
}

/** 模块的字段定义（用于取值校验与审计）/ a module's definitions (for value checks and audits) */
const defsOf = (organizationId: string, moduleId: string) =>
  prisma.customModuleField.findMany({ where: { organizationId, moduleId }, select: fieldSelect, orderBy: { position: 'asc' } });

/**
 * 新建记录。
 * Create a record.
 */
export async function createRecord(ctx: AuthContext, input: z.infer<typeof recordCreateSchema>) {
  requirePermission(ctx, 'record.create');
  const { moduleId, ownerId, accountId, custom, name } = input;
  assertActive(await requireModule(ctx, moduleId));
  assertOwnerAssignable(ctx, ownerId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  await assertAccount(ctx, accountId);
  const defs = await defsOf(ctx.organizationId, moduleId);
  const { values } = mergeCustom(defs, custom, null);
  return prisma.$transaction(async (tx) => {
    // 与删除模块互斥（删除时锁住模块行）/ exclusive with module deletion (which locks the module row)
    const live = await tx.$queryRaw<{ is_active: boolean }[]>`SELECT is_active FROM custom_modules WHERE id = ${moduleId}::uuid FOR SHARE`;
    const row = live[0];
    if (!row) throw notFound();
    assertActive({ isActive: row.is_active });
    const r = await tx.customRecord.create({
      data: { organizationId: ctx.organizationId, moduleId, name, ownerId: owner, accountId: accountId ?? null, values: values as Prisma.InputJsonValue, createdById: ctx.userId },
      include: recordInclude,
    });
    const customChanges = customDiff(defs, null, values);
    await audit(tx, {
      ...by(ctx),
      action: 'customrecord.create',
      entityType: 'customrecord',
      entityId: r.id,
      changes: { module: r.module.name, after: snapshot('customrecord', r), ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) },
    });
    return r;
  });
}

/**
 * 修改记录（需负责人或编辑全部权限；模块须启用）。
 * Update a record (owner or update-all; the module must be active).
 */
export async function updateRecord(ctx: AuthContext, id: string, input: z.infer<typeof recordUpdateSchema>) {
  const { ownerId, accountId, custom, name } = input;
  const current = await getRecord(ctx, id);
  assertCanUpdate(ctx, current);
  assertActive(current.module);
  assertOwnerAssignable(ctx, ownerId);
  const owner = ownerId === undefined ? undefined : await resolveOwner(ctx.organizationId, ownerId, null);
  if (accountId !== undefined) await assertAccount(ctx, accountId);
  const defs = await defsOf(ctx.organizationId, current.moduleId);
  const { values } = mergeCustom(defs, custom, current.values);
  return prisma.$transaction(async (tx) => {
    // 只在负责人未变时写入，避免与并发改派竞争 / write only while the owner is unchanged (guards concurrent reassignment)
    const res = await tx.customRecord.updateMany({
      where: { id, organizationId: ctx.organizationId, ownerId: current.ownerId },
      data: { name, ownerId: owner, accountId, ...(custom !== undefined ? { values: values as Prisma.InputJsonValue } : {}) },
    });
    if (!res.count) throw new ApiError(409, 'CONFLICT', 'The record changed, reload and retry', { record: ['stale'] });
    const r = await tx.customRecord.findUniqueOrThrow({ where: { id }, include: recordInclude });
    const before = snapshot('customrecord', current);
    const after = snapshot('customrecord', r);
    const fields = Object.fromEntries(Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => [k, [before[k], after[k]]]));
    const customChanges = custom !== undefined ? customDiff(defs, current.values, values) : {};
    if (Object.keys(fields).length || Object.keys(customChanges).length) {
      await audit(tx, {
        ...by(ctx),
        action: 'customrecord.update',
        entityType: 'customrecord',
        entityId: id,
        changes: { module: r.module.name, name: r.name, fields, ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) },
      });
    }
    return r;
  });
}

/**
 * 删除记录（需删除权限；直接删除，不进回收站）。
 * Delete a record (delete permission; immediate, no recycle bin).
 */
export async function deleteRecord(ctx: AuthContext, id: string): Promise<void> {
  assertCanDelete(ctx);
  const current = await getRecord(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.customRecord.delete({ where: { id } });
    const defs = await defsOf(ctx.organizationId, current.moduleId);
    const customChanges = customDiff(defs, current.values, {});
    await audit(tx, {
      ...by(ctx),
      action: 'customrecord.delete',
      entityType: 'customrecord',
      entityId: id,
      changes: { module: current.module.name, before: snapshot('customrecord', current), ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) },
    });
  });
}
