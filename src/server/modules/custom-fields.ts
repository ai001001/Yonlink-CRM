/**
 * 自定义字段（对标 Zoho Custom Fields）：管理员为线索、客户、联系人、商机添加字段，值保存在记录的 custom 列。
 * - 类型：单行文本（≤255）、多行文本（≤5000）、数字（最多 16 位整数、4 位小数，按字符串保存）、日期（YYYY-MM-DD）、
 *   下拉单选（1–50 个选项）、勾选、网址（http/https）、邮箱。每个对象最多 30 个字段；字段键由服务端生成且不变。
 * - 取值：新建、编辑时随记录提交 `custom: { 字段键: 值 }`；只接受启用字段，按类型校验与规范化；值为 null 或空字符串
 *   表示清除；编辑只改提交的键。必填字段在新建时必须有值；编辑时只要提交了 custom 就检查（批量、看板等不改自定义字段
 *   的操作不受影响）。勾选字段不能设为必填。
 * - 停用字段：不显示、不能填写，已有值保留；删除字段：同时清除各记录的值。修改选项不影响已有值。
 * - 维护需 customfield.manage（管理员）并写审计；所有用户可读取定义。记录审计中文本类的值脱敏。
 * Custom fields (cf. Zoho Custom Fields): admins add fields to leads, accounts, contacts and deals; values live in the
 * record's custom column. Types: text (≤255), text area (≤5000), number (≤16 integer and 4 decimal digits, kept as a
 * string), date, picklist (1–50 options), checkbox, URL (http/https) and email; at most 30 fields per entity; keys are
 * server-generated and immutable. Values travel as `custom: { key: value }` on create and edit; only active fields are
 * accepted, validated and normalised per type; null or an empty string clears; edits change only the keys sent.
 * Required fields must be filled on create and whenever an edit sends custom (bulk and board edits are unaffected);
 * checkboxes cannot be required. Inactive fields are hidden and read-only with values kept; deleting a field removes
 * its values everywhere; changing options leaves existing values alone. Maintenance needs customfield.manage (admins)
 * and is audited; everyone can read definitions; text-like values are redacted in record audits.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { CustomEntity, CustomFieldType } from '@/generated/prisma/enums';
import { audit, by, REDACTED } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCustomWrites, CUSTOM_PREFIX, lockedCustomKeys } from '../field-security';
import { requirePermission } from '../permissions';
import { requiredText } from '../validation';

/** 每个对象最多字段数 / max fields per entity */
export const MAX_CUSTOM_FIELDS = 30;
/** 审计中脱敏的类型 / types redacted in audits */
const REDACTED_TYPES = new Set<CustomFieldType>([CustomFieldType.TEXT, CustomFieldType.TEXTAREA, CustomFieldType.URL, CustomFieldType.EMAIL]);

/** 请求中的自定义值 / custom values in a request */
export const customInput = z.record(z.string().max(30), z.unknown()).optional();

/** 下拉选项（自定义模块字段共用）/ picklist options (shared with custom module fields) */
export const fieldOptions = z
  .array(requiredText(50))
  .max(50)
  .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, 'duplicate_options');

/**
 * 字段定义的组合校验：下拉必须有选项、其他类型不能有选项、勾选不能必填（自定义模块字段共用）。
 * Cross-field checks of a definition: picklists need options, others have none, checkboxes cannot be required (shared
 * with custom module fields).
 */
export function checkFieldDef(v: { type: CustomFieldType; options: string[]; required: boolean }, ctx: z.RefinementCtx): void {
  if (v.type === CustomFieldType.PICKLIST && !v.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'required' });
  if (v.type !== CustomFieldType.PICKLIST && v.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'not_allowed' });
  if (v.type === CustomFieldType.CHECKBOX && v.required) ctx.addIssue({ code: 'custom', path: ['required'], message: 'not_allowed' });
}

/** 新建字段 / create a field */
export const customFieldCreateSchema = z
  .strictObject({ entity: z.enum(CustomEntity), label: requiredText(50), type: z.enum(CustomFieldType), options: fieldOptions.default([]), required: z.boolean().default(false) })
  .superRefine(checkFieldDef);
/** 修改字段（类型与对象不可改；自定义模块字段共用）/ update a field (type and entity are fixed; shared with module fields) */
export const customFieldUpdateSchema = z.strictObject({ label: requiredText(50), options: fieldOptions, required: z.boolean(), isActive: z.boolean() }).partial();
/** 列表 / list */
export const customFieldListSchema = z.strictObject({ entity: z.enum(CustomEntity).optional() });

const select = { id: true, entity: true, key: true, label: true, type: true, options: true, required: true, isActive: true, position: true, createdAt: true, updatedAt: true } satisfies Prisma.CustomFieldSelect;
type Field = Prisma.CustomFieldGetPayload<{ select: typeof select }>;

/** 标签重复 / duplicate label */
function labelTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Field label already exists', { label: ['taken'] });
  throw err;
}

/**
 * 字段定义（按对象与顺序）。
 * Field definitions by entity and order.
 */
export async function listCustomFields(ctx: AuthContext, query: z.infer<typeof customFieldListSchema>) {
  return { items: await prisma.customField.findMany({ where: { organizationId: ctx.organizationId, entity: query.entity }, select, orderBy: [{ entity: 'asc' }, { position: 'asc' }] }) };
}

/**
 * 新建字段（同一对象串行判断上限与顺序）。
 * Create a field (cap and position are decided under a per-entity lock).
 */
export async function createCustomField(ctx: AuthContext, input: z.infer<typeof customFieldCreateSchema>) {
  requirePermission(ctx, 'customfield.manage');
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`customfield:${ctx.organizationId}:${input.entity}`}, 0))`;
      const count = await tx.customField.count({ where: { organizationId: ctx.organizationId, entity: input.entity } });
      if (count >= MAX_CUSTOM_FIELDS) throw new ApiError(409, 'CONFLICT', 'Too many custom fields', { label: ['limit_reached'] });
      const last = await tx.customField.aggregate({ where: { organizationId: ctx.organizationId, entity: input.entity }, _max: { position: true } });
      const key = `cf_${randomBytes(8).toString('hex').slice(0, 8)}`;
      const field = await tx.customField.create({ data: { ...input, organizationId: ctx.organizationId, key, position: (last._max.position ?? -1) + 1 }, select });
      await audit(tx, { ...by(ctx), action: 'customfield.create', entityType: 'customfield', entityId: field.id, changes: { after: { entity: field.entity, key, label: field.label, type: field.type, options: field.options, required: field.required } } });
      return field;
    });
  } catch (err) {
    labelTaken(err);
  }
}

/**
 * 修改字段（标签、选项、必填、启停）。
 * Update a field (label, options, required, active).
 */
export async function updateCustomField(ctx: AuthContext, id: string, input: z.infer<typeof customFieldUpdateSchema>) {
  requirePermission(ctx, 'customfield.manage');
  const current = await prisma.customField.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  if (input.options !== undefined && current.type !== CustomFieldType.PICKLIST) throw new ApiError(400, 'VALIDATION_ERROR', 'Only picklists have options', { options: ['not_allowed'] });
  if (input.options !== undefined && !input.options.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Picklists need options', { options: ['required'] });
  if (input.required && current.type === CustomFieldType.CHECKBOX) throw new ApiError(400, 'VALIDATION_ERROR', 'Checkboxes cannot be required', { required: ['not_allowed'] });
  try {
    return await prisma.$transaction(async (tx) => {
      const field = await tx.customField.update({ where: { id }, data: input, select });
      const fields = Object.fromEntries(
        (['label', 'options', 'required', 'isActive'] as const).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(field[k])).map((k) => [k, [current[k], field[k]]]),
      );
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'customfield.update', entityType: 'customfield', entityId: id, changes: { key: current.key, fields } });
      return field;
    });
  } catch (err) {
    labelTaken(err);
  }
}

/**
 * 删除字段：同时清除各记录中该字段的值与字段权限设置。
 * Delete a field and remove its values from every record and its field permission settings.
 */
export async function deleteCustomField(ctx: AuthContext, id: string): Promise<{ cleared: number }> {
  requirePermission(ctx, 'customfield.manage');
  const current = await prisma.customField.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  return prisma.$transaction(async (tx) => {
    await tx.customField.delete({ where: { id } });
    const org = ctx.organizationId;
    const key = current.key;
    // 字段权限设置随字段删除 / the field's permission settings go with it
    await tx.fieldPermission.deleteMany({ where: { organizationId: org, entity: current.entity, field: CUSTOM_PREFIX + key } });
    // 表名固定，不拼接用户输入；键格式已由约束限定 / fixed table names; the key format is constrained
    const cleared =
      current.entity === CustomEntity.LEAD
        ? await tx.$executeRaw`UPDATE leads SET custom = custom - ${key} WHERE organization_id = ${org}::uuid AND custom ? ${key}`
        : current.entity === CustomEntity.ACCOUNT
          ? await tx.$executeRaw`UPDATE accounts SET custom = custom - ${key} WHERE organization_id = ${org}::uuid AND custom ? ${key}`
          : current.entity === CustomEntity.CONTACT
            ? await tx.$executeRaw`UPDATE contacts SET custom = custom - ${key} WHERE organization_id = ${org}::uuid AND custom ? ${key}`
            : await tx.$executeRaw`UPDATE deals SET custom = custom - ${key} WHERE organization_id = ${org}::uuid AND custom ? ${key}`;
    await audit(tx, { ...by(ctx), action: 'customfield.delete', entityType: 'customfield', entityId: id, changes: { before: { entity: current.entity, key, label: current.label, type: current.type }, cleared } });
    return { cleared };
  });
}

/** 读取对象的全部字段定义 / all definitions of an entity */
export function fieldsOf(organizationId: string, entity: CustomEntity, client: Prisma.TransactionClient = prisma): Promise<Field[]> {
  return client.customField.findMany({ where: { organizationId, entity }, select, orderBy: { position: 'asc' } });
}

/**
 * 校验并规范化一个值；返回 undefined 表示清除，抛出代码表示不合法。
 * Validate and normalise one value; undefined clears it; a thrown code means invalid.
 */
export function normalize(field: Pick<Field, 'type' | 'options'>, raw: unknown): unknown {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return undefined;
  const text = (max: number) => {
    if (typeof raw !== 'string') throw 'invalid';
    const v = raw.trim();
    if (v.length > max) throw 'too_long';
    return v;
  };
  switch (field.type) {
    case CustomFieldType.TEXT:
      return text(255);
    case CustomFieldType.TEXTAREA:
      return text(5000);
    case CustomFieldType.NUMBER: {
      const v = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
      if (!/^-?\d{1,16}(\.\d{1,4})?$/.test(v)) throw 'invalid_number';
      return new Prisma.Decimal(v).toString();
    }
    case CustomFieldType.DATE: {
      const v = text(10);
      const d = new Date(`${v}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw 'invalid_date';
      return v;
    }
    case CustomFieldType.PICKLIST: {
      const v = text(50);
      if (!(field.options as string[]).includes(v)) throw 'invalid_option';
      return v;
    }
    case CustomFieldType.CHECKBOX:
      if (typeof raw !== 'boolean') throw 'invalid';
      return raw;
    case CustomFieldType.URL: {
      const v = text(500);
      if (!/^https?:\/\/\S+$/i.test(v)) throw 'invalid_url';
      return v;
    }
    case CustomFieldType.EMAIL: {
      const v = text(254);
      if (!z.email().safeParse(v).success) throw 'invalid_email';
      return v.toLowerCase();
    }
  }
}

/**
 * 合并并校验记录的自定义值：只接受启用字段；必填在新建时、或编辑提交了 custom 时检查。传入身份时按字段权限检查写入
 * （隐藏字段不能提交、只读字段只能保持原值），且不可编辑的字段不要求必填。
 * Merge and validate a record's custom values: active fields only; required fields are checked on create or when an
 * edit sends custom. With an identity, field-level security applies (hidden fields cannot be sent, read-only ones keep
 * their value) and fields the user cannot edit are not required.
 * @returns 合并后的值与定义（用于审计）/ the merged values and definitions (for auditing)
 */
export async function resolveCustom(organizationId: string, entity: CustomEntity, input: Record<string, unknown> | undefined, current: Prisma.JsonValue | null, ctx?: AuthContext) {
  const defs = await fieldsOf(organizationId, entity);
  if (ctx?.fieldRules?.[entity] && input) {
    const normalized = new Map<string, unknown>();
    for (const [key, raw] of Object.entries(input)) {
      const def = defs.find((d) => d.key === key && d.isActive);
      if (!def) continue;
      try {
        normalized.set(key, normalize(def, raw));
      } catch {
        // 不合法的值视为修改（只读字段因此拒绝）/ an invalid value counts as a change (refused on read-only fields)
        normalized.set(key, { invalid: true });
      }
    }
    const cur = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
    assertCustomWrites(ctx, entity, normalized, cur);
  }
  return mergeCustom(defs, input, current, ctx ? lockedCustomKeys(ctx, entity) : undefined);
}

/**
 * 按给定定义合并并校验自定义值（自定义模块的记录共用）；错误键为 custom.字段键。
 * Merge and validate custom values against the given definitions (shared with custom module records); error keys are
 * custom.<key>.
 * @param current 现有值；null 表示新建 / existing values; null on create
 * @param exempt 不检查必填的字段键（当前用户不可编辑）/ keys exempt from the required check (not editable by the user)
 */
export function mergeCustom<D extends Pick<Field, 'key' | 'type' | 'options' | 'required' | 'isActive'>>(defs: D[], input: Record<string, unknown> | undefined, current: Prisma.JsonValue | null, exempt?: Set<string>) {
  const merged: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  const errors: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(input ?? {})) {
    const def = defs.find((d) => d.key === key && d.isActive);
    if (!def) {
      errors[`custom.${key}`] = ['unknown_field'];
      continue;
    }
    try {
      const v = normalize(def, raw);
      if (v === undefined) delete merged[key];
      else merged[key] = v;
    } catch (code) {
      errors[`custom.${key}`] = [String(code)];
    }
  }
  if (current === null || input !== undefined) {
    for (const d of defs) if (d.isActive && d.required && !exempt?.has(d.key) && (merged[d.key] === undefined || merged[d.key] === null)) errors[`custom.${d.key}`] ??= ['required'];
  }
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid custom fields', errors);
  return { values: merged, defs };
}

/**
 * 自定义值的审计差异（按字段名称；文本类脱敏）。
 * Audit differences of custom values (by label; text-like values redacted).
 */
export function customDiff(defs: Pick<Field, 'key' | 'label' | 'type'>[], before: Prisma.JsonValue | null, after: Record<string, unknown>) {
  const b = (before && typeof before === 'object' && !Array.isArray(before) ? before : {}) as Record<string, unknown>;
  const out: Record<string, [unknown, unknown]> = {};
  for (const d of defs) {
    const x = b[d.key] ?? null;
    const y = after[d.key] ?? null;
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const show = (v: unknown) => (v !== null && REDACTED_TYPES.has(d.type) ? REDACTED : v);
    out[d.label] = [show(x), show(y)];
  }
  return out;
}
