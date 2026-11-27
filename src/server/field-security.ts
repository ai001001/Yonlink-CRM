/**
 * 字段级权限（对标 Zoho 的 Field-level Security）：按系统角色或自定义角色把线索、客户、联系人、商机的部分字段设为隐藏或只读。
 * - 系统管理员不受限；使用自定义角色的用户只按该自定义角色的设置，否则按系统角色的设置。
 * - 规则在认证时与身份一起从数据库读取（每个请求一次），修改后下一个请求立即生效。
 * - 隐藏：读取时从返回内容中去掉，搜索不再匹配，写入（含值相同）一律拒绝。
 * - 只读：可以看到，写入时只允许保持原值（新建时只能留空）。
 * - 可限制的标准字段见 RESTRICTABLE（数据库约束同步）；名称、阶段、金额、负责人等核心字段不可限制。自定义字段均可限制。
 * Field-level security (cf. Zoho): fields of leads, accounts, contacts and deals are hidden or read-only per system role
 * or custom role. Administrators are never restricted; users with a custom role follow that role's settings, others
 * their system role's. Rules are read with the identity on every request, so changes apply on the next request.
 * Hidden: removed from responses, not matched by search, and every write is refused (even with the same value).
 * Read-only: visible; writes must keep the value (empty on create). Restrictable standard fields are listed in
 * RESTRICTABLE (mirrored by a database check); core fields such as name, stage, amount and owner are not. Every custom
 * field is restrictable.
 */
import type { CustomEntity, FieldAccess, UserRole } from '@/generated/prisma/enums';
import type { AuthContext } from './auth';
import { prisma } from './db';
import { ApiError } from './errors';

/** 受字段权限控制的对象 / entities under field-level security */
export type FieldEntity = CustomEntity;
/** 某个用户的规则：对象 → 字段 → 访问级别（未列出即可编辑）/ a user's rules: entity → field → access (unlisted = editable) */
export type FieldRules = Partial<Record<FieldEntity, Record<string, FieldAccess>>>;

/** 自定义字段在规则中的前缀 / prefix of custom fields in rules */
export const CUSTOM_PREFIX = 'custom.';

/** 可限制的标准字段（与数据库约束一致）/ restrictable standard fields (mirrors the database check) */
export const RESTRICTABLE: Record<FieldEntity, readonly string[]> = {
  LEAD: ['title', 'phone', 'mobile', 'email', 'description'],
  ACCOUNT: ['phone', 'website', 'address', 'description'],
  CONTACT: ['title', 'phone', 'email'],
  DEAL: ['description'],
};

/** 审计对象类型对应的字段权限对象 / field-security entity of each audit entity type */
export const AUDIT_ENTITY: Record<string, FieldEntity> = { lead: 'LEAD', account: 'ACCOUNT', contact: 'CONTACT', deal: 'DEAL' };

/**
 * 读取某个身份的字段规则；系统管理员没有规则。
 * Load the field rules of an identity; administrators have none.
 */
export async function loadFieldRules(organizationId: string, role: UserRole, customRoleId: string | null): Promise<FieldRules | undefined> {
  if (role === 'ADMIN') return undefined;
  const rows = await prisma.fieldPermission.findMany({
    where: { organizationId, ...(customRoleId ? { customRoleId } : { role, customRoleId: null }) },
    select: { entity: true, field: true, access: true },
  });
  const rules: FieldRules = {};
  for (const r of rows) (rules[r.entity] ??= {})[r.field] = r.access;
  return rules;
}

/**
 * 字段的访问级别（无规则即可编辑）。
 * Access level of a field (editable without a rule).
 */
export function accessOf(ctx: AuthContext, entity: FieldEntity, field: string): FieldAccess | 'EDIT' {
  return ctx.fieldRules?.[entity]?.[field] ?? 'EDIT';
}

/** 隐藏的标准字段 / hidden standard fields */
export function hiddenFields(ctx: AuthContext, entity: FieldEntity): string[] {
  const rules = ctx.fieldRules?.[entity];
  return rules ? Object.keys(rules).filter((f) => rules[f] === 'HIDDEN' && !f.startsWith(CUSTOM_PREFIX)) : [];
}

/** 不可编辑（隐藏或只读）的标准字段 / standard fields that are not editable (hidden or read-only) */
export function lockedFields(ctx: AuthContext, entity: FieldEntity): string[] {
  const rules = ctx.fieldRules?.[entity];
  return rules ? Object.keys(rules).filter((f) => !f.startsWith(CUSTOM_PREFIX)) : [];
}

/** 隐藏的自定义字段键 / hidden custom field keys */
export function hiddenCustomKeys(ctx: AuthContext, entity: FieldEntity): Set<string> {
  const rules = ctx.fieldRules?.[entity];
  return new Set(rules ? Object.keys(rules).filter((f) => rules[f] === 'HIDDEN' && f.startsWith(CUSTOM_PREFIX)).map((f) => f.slice(CUSTOM_PREFIX.length)) : []);
}

/** 不可编辑（隐藏或只读）的自定义字段键 / custom field keys that are not editable (hidden or read-only) */
export function lockedCustomKeys(ctx: AuthContext, entity: FieldEntity): Set<string> {
  const rules = ctx.fieldRules?.[entity];
  return new Set(rules ? Object.keys(rules).filter((f) => f.startsWith(CUSTOM_PREFIX)).map((f) => f.slice(CUSTOM_PREFIX.length)) : []);
}

/**
 * 去掉不可见的搜索字段（避免用搜索探测隐藏的值）。
 * Drop hidden fields from search (no probing of hidden values through search).
 */
export function searchable<T extends string>(ctx: AuthContext, entity: FieldEntity, fields: readonly T[]): T[] {
  const hidden = hiddenFields(ctx, entity);
  return fields.filter((f) => !hidden.includes(f));
}

/**
 * 去掉记录中的隐藏字段（返回副本；可同时处理关联记录，如客户下的联系人）。
 * Remove hidden fields from a record (returns a copy; related records such as an account's contacts can be masked too).
 * @param nested 关联属性 → 对象（数组或单个记录）/ relation property → entity (array or single record)
 */
export function maskRecord<T>(ctx: AuthContext, entity: FieldEntity, record: T, nested: Record<string, FieldEntity> = {}): T {
  if (!ctx.fieldRules || !record || typeof record !== 'object') return record;
  const out = { ...(record as Record<string, unknown>) };
  for (const f of hiddenFields(ctx, entity)) delete out[f];
  const keys = hiddenCustomKeys(ctx, entity);
  if (keys.size && out.custom && typeof out.custom === 'object' && !Array.isArray(out.custom)) {
    out.custom = Object.fromEntries(Object.entries(out.custom as Record<string, unknown>).filter(([k]) => !keys.has(k)));
  }
  for (const [prop, e] of Object.entries(nested)) {
    const v = out[prop];
    if (Array.isArray(v)) out[prop] = v.map((x) => maskRecord(ctx, e, x));
    else if (v && typeof v === 'object') out[prop] = maskRecord(ctx, e, v);
  }
  return out as T;
}

/** 批量去掉隐藏字段 / mask a list of records */
export function maskRecords<T>(ctx: AuthContext, entity: FieldEntity, records: T[], nested: Record<string, FieldEntity> = {}): T[] {
  return ctx.fieldRules ? records.map((r) => maskRecord(ctx, entity, r, nested)) : records;
}

/** 分页结果去掉隐藏字段 / mask a page of records */
export function maskPage<P extends { items: unknown[] }>(ctx: AuthContext, entity: FieldEntity, page: P, nested: Record<string, FieldEntity> = {}): P {
  return ctx.fieldRules ? { ...page, items: maskRecords(ctx, entity, page.items, nested) } : page;
}

/** 比较用的规范值 / comparable value */
function norm(v: unknown): unknown {
  if (v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

/**
 * 检查标准字段的写入：编辑时隐藏字段不能出现在输入中（值相同也拒绝，避免用写入探测隐藏的值）；只读字段只能保持原值；
 * 新建时两者都只能留空。
 * Check writes to standard fields: on edit, hidden fields must not be sent (even with the same value, so writes cannot
 * probe hidden values) and read-only ones must keep their value; on create both must stay empty.
 * @param current 现有记录；null 表示新建 / the existing record; null on create
 * @throws ApiError 403 字段级错误 field_hidden / field_read_only
 */
export function assertFieldWrites(ctx: AuthContext, entity: FieldEntity, input: Record<string, unknown>, current: Record<string, unknown> | null): void {
  const rules = ctx.fieldRules?.[entity];
  if (!rules) return;
  const errors: Record<string, string[]> = {};
  for (const [field, access] of Object.entries(rules)) {
    if (field.startsWith(CUSTOM_PREFIX) || input[field] === undefined) continue;
    // 新建时输入校验会把未填的字段补为空值，只有填了值才算写入 / on create, validation fills missing fields with null; only values count
    if (access === 'HIDDEN') {
      if (current !== null || norm(input[field]) !== null) errors[field] = ['field_hidden'];
    }
    else if (JSON.stringify(norm(input[field])) !== JSON.stringify(norm(current?.[field]))) errors[field] = ['field_read_only'];
  }
  if (Object.keys(errors).length) throw new ApiError(403, 'FORBIDDEN', 'Field not editable', errors);
}

/**
 * 检查自定义字段的写入（值已按字段类型规范化）：规则同标准字段，错误键为 custom.字段键。
 * Check writes to custom fields (values already normalised by type); same rules as standard fields, error keys are
 * custom.<key>.
 * @param normalized 输入中各字段规范化后的值（undefined 表示清空）/ normalised input values (undefined clears)
 */
export function assertCustomWrites(ctx: AuthContext, entity: FieldEntity, normalized: Map<string, unknown>, current: Record<string, unknown>): void {
  const rules = ctx.fieldRules?.[entity];
  if (!rules) return;
  const errors: Record<string, string[]> = {};
  for (const [key, value] of normalized) {
    const access = rules[CUSTOM_PREFIX + key];
    if (!access) continue;
    if (access === 'HIDDEN') errors[CUSTOM_PREFIX + key] = ['field_hidden'];
    else if (JSON.stringify(value ?? null) !== JSON.stringify(current[key] ?? null)) errors[CUSTOM_PREFIX + key] = ['field_read_only'];
  }
  if (Object.keys(errors).length) throw new ApiError(403, 'FORBIDDEN', 'Field not editable', errors);
}

/**
 * 去掉审计变更中的隐藏字段（快照、字段差异按字段名；自定义字段差异按字段名称）。
 * Remove hidden fields from audit changes (snapshots and field diffs by field name; custom diffs by label).
 * @param customLabels 自定义字段键 → 名称 / custom field key → label
 */
export function maskChanges(ctx: AuthContext, entity: FieldEntity, changes: unknown, customLabels: Map<string, string>): unknown {
  if (!ctx.fieldRules?.[entity] || !changes || typeof changes !== 'object' || Array.isArray(changes)) return changes;
  const hidden = hiddenFields(ctx, entity);
  const labels = new Set([...hiddenCustomKeys(ctx, entity)].map((k) => customLabels.get(k)).filter((l): l is string => !!l));
  const strip = (obj: unknown, keys: Iterable<string>) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = { ...(obj as Record<string, unknown>) };
    for (const k of keys) delete out[k];
    return out;
  };
  const out = { ...(changes as Record<string, unknown>) };
  for (const k of ['after', 'before', 'fields']) if (k in out) out[k] = strip(out[k], hidden);
  if ('custom' in out) out.custom = strip(out.custom, labels);
  return out;
}

/**
 * 去掉审计记录变更中的隐藏字段（时间线、审计日志）；需要时读取自定义字段名称。
 * Remove hidden fields from audit entries' changes (timeline, audit log); custom field labels are read when needed.
 */
export async function maskAuditEntries<E extends { entityType: string; changes: unknown }>(ctx: AuthContext, entries: E[]): Promise<E[]> {
  if (!ctx.fieldRules) return entries;
  const entities = [...new Set(entries.map((e) => AUDIT_ENTITY[e.entityType]).filter((e): e is FieldEntity => !!e && !!ctx.fieldRules?.[e]))];
  if (!entities.length) return entries;
  const needLabels = entities.filter((e) => hiddenCustomKeys(ctx, e).size);
  const defs = needLabels.length ? await prisma.customField.findMany({ where: { organizationId: ctx.organizationId, entity: { in: needLabels } }, select: { entity: true, key: true, label: true } }) : [];
  const labels = new Map(entities.map((e) => [e, new Map(defs.filter((d) => d.entity === e).map((d) => [d.key, d.label]))]));
  return entries.map((e) => {
    const entity = AUDIT_ENTITY[e.entityType];
    return entity && labels.has(entity) ? { ...e, changes: maskChanges(ctx, entity, e.changes, labels.get(entity)!) } : e;
  });
}
