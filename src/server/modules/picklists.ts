/**
 * 标准下拉字段的配置（对标 Zoho 的“编辑选项列表”）：管理员调整线索来源、行业、线索状态、商机阶段、跟进类型的选项。
 * - 线索来源、行业：可新增自定义选项（代码由服务端按名称生成）、改名、调整顺序、停用；内置选项不能删除；
 *   自定义选项未被记录使用时可删除，使用中只能停用。
 * - 线索状态、商机阶段、跟进类型：其值关联业务逻辑，只能改名与停用，不能新增或调整顺序；线索“新建”“已转化”与
 *   商机“赢单”“输单”不能停用。进行中的商机阶段可设置赢单概率（0–100），用于加权预测与阶段历史的预期收入。
 * - 改名对所有显示生效（名称为空时用内置的多语言名称）；停用的选项在新建、编辑时不能再选，已有记录保留原值。
 * - 所有用户可读取；修改需 customfield.manage（管理员），整组替换并写审计；同一组织同一字段串行修改。
 * Standard picklist configuration (cf. Zoho "edit pick list values"): lead source and industry accept custom options
 * (server-generated codes), renaming, reordering and deactivation; built-ins cannot be removed and custom options can
 * be deleted only while unused. Lead status, deal stage and activity type drive business logic: rename and deactivate
 * only (no new values, fixed order); NEW/CONVERTED and CLOSED_WON/CLOSED_LOST stay active. Open deal stages carry a
 * win probability (0–100) used by weighted forecasts and stage history. Labels apply everywhere (null = built-in
 * localized label); inactive options cannot be chosen on create or edit while existing records keep them. Everyone
 * reads; changes need customfield.manage (admins), replace the whole list, are audited and serialized per field.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { ActivityType, DealStage, LeadStatus, PicklistField } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { requirePermission } from '../permissions';
import { optionalText } from '../validation';
import { INDUSTRIES, LEAD_SOURCES } from './dictionaries';

/** 选项代码格式（内置值与自定义值）/ option code format (built-in and custom) */
export const PICKLIST_CODE = /^[A-Z][A-Z0-9_]{0,29}$/;
/** 规则与表单中引用选项代码的校验 / schema for option codes referenced by rules and forms */
export const picklistCode = z.string().regex(PICKLIST_CODE, 'invalid_option');

/** 各字段的内置选项（顺序即默认顺序）/ built-in options per field (default order) */
export const BUILTIN: Record<PicklistField, readonly string[]> = {
  LEAD_SOURCE: LEAD_SOURCES,
  INDUSTRY: INDUSTRIES,
  LEAD_STATUS: Object.values(LeadStatus),
  DEAL_STAGE: Object.values(DealStage),
  ACTIVITY_TYPE: Object.values(ActivityType),
};
/** 可新增自定义选项、可调整顺序的字段 / fields accepting custom options and reordering */
export const EXTENSIBLE = new Set<PicklistField>([PicklistField.LEAD_SOURCE, PicklistField.INDUSTRY]);
/** 不能停用的选项 / options that must stay active */
export const LOCKED: Record<PicklistField, readonly string[]> = {
  LEAD_SOURCE: [],
  INDUSTRY: [],
  LEAD_STATUS: [LeadStatus.NEW, LeadStatus.CONVERTED],
  DEAL_STAGE: [DealStage.CLOSED_WON, DealStage.CLOSED_LOST],
  ACTIVITY_TYPE: [],
};
/** 进行中商机阶段的默认赢单概率（%）/ default win probability of open deal stages (%) */
export const DEFAULT_PROBABILITY: Record<string, number> = { QUALIFICATION: 10, NEEDS_ANALYSIS: 20, PROPOSAL: 40, NEGOTIATION: 70 };
/** 已结束阶段的固定概率 / fixed probability of closed stages */
const CLOSED_PROBABILITY: Record<string, number> = { CLOSED_WON: 100, CLOSED_LOST: 0 };
/** 每个字段最多选项数 / max options per field */
export const MAX_OPTIONS = 100;
/** 前端与 i18n 中各字段的枚举前缀 / i18n enum prefix per field */
export const I18N_PREFIX: Record<PicklistField, string> = { LEAD_SOURCE: 'leadSource', INDUSTRY: 'industry', LEAD_STATUS: 'leadStatus', DEAL_STAGE: 'dealStage', ACTIVITY_TYPE: 'activityType' };

/** 一个选项 / one option */
export interface PicklistOption {
  value: string;
  label: string | null;
  isActive: boolean;
  isCustom: boolean;
  locked: boolean;
  probability: number | null;
}

/** 修改请求 / update request */
export const picklistUpdateSchema = z.strictObject({
  values: z
    .array(
      z.strictObject({
        /** 新增的自定义选项不传 value / new custom options omit the value */
        value: picklistCode.optional(),
        label: optionalText(50),
        isActive: z.boolean(),
        probability: z.number().int().min(0).max(100).nullish(),
      }),
    )
    .min(1)
    .max(MAX_OPTIONS),
});
/** 字段参数 / field parameter */
export const picklistFieldSchema = z.enum(PicklistField);

/** 默认配置 / default configuration */
function defaults(field: PicklistField): PicklistOption[] {
  return BUILTIN[field].map((value) => ({
    value,
    label: null,
    isActive: true,
    isCustom: false,
    locked: LOCKED[field].includes(value),
    probability: field === PicklistField.DEAL_STAGE ? (DEFAULT_PROBABILITY[value] ?? null) : null,
  }));
}

/**
 * 某字段的生效配置（按顺序；没有配置时为内置默认）。
 * The effective options of a field in order (built-in defaults when unconfigured).
 */
export async function getPicklist(organizationId: string, field: PicklistField, client: Prisma.TransactionClient = prisma): Promise<PicklistOption[]> {
  const rows = await client.picklistValue.findMany({ where: { organizationId, field }, orderBy: [{ position: 'asc' }, { value: 'asc' }] });
  if (!rows.length) return defaults(field);
  return rows.map((r) => ({
    value: r.value,
    label: r.label,
    isActive: r.isActive,
    isCustom: !BUILTIN[field].includes(r.value),
    locked: LOCKED[field].includes(r.value),
    probability: r.probability,
  }));
}

/**
 * 全部字段的生效配置（所有用户可读）。
 * Effective options of every field (readable by everyone).
 */
export async function listPicklists(ctx: AuthContext): Promise<{ fields: Record<PicklistField, PicklistOption[]> }> {
  const rows = await prisma.picklistValue.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ position: 'asc' }, { value: 'asc' }] });
  const fields = {} as Record<PicklistField, PicklistOption[]>;
  for (const field of Object.values(PicklistField)) {
    const mine = rows.filter((r) => r.field === field);
    fields[field] = mine.length
      ? mine.map((r) => ({ value: r.value, label: r.label, isActive: r.isActive, isCustom: !BUILTIN[field].includes(r.value), locked: LOCKED[field].includes(r.value), probability: r.probability }))
      : defaults(field);
  }
  return { fields };
}

/** 选项被记录使用的数量（自定义选项删除前检查）/ records using an option (checked before deleting a custom option) */
function usage(tx: Prisma.TransactionClient, organizationId: string, field: PicklistField, value: string): Promise<number> {
  if (field === PicklistField.LEAD_SOURCE) return tx.lead.count({ where: { organizationId, source: value } });
  return tx.account.count({ where: { organizationId, industry: value } });
}

/**
 * 整组替换某字段的配置（见模块说明的规则）；返回新的配置。
 * Replace a field's options (rules in the module notes) and return the new list.
 */
export async function updatePicklist(ctx: AuthContext, field: PicklistField, input: z.infer<typeof picklistUpdateSchema>): Promise<PicklistOption[]> {
  requirePermission(ctx, 'customfield.manage');
  const builtin = BUILTIN[field];
  const errors: Record<string, string[]> = {};
  const add = (key: string, code: string) => (errors[key] ??= []).push(code);
  const seen = new Set<string>();
  const labels = new Set<string>();
  for (const [i, v] of input.values.entries()) {
    if (v.value) {
      if (seen.has(v.value)) add(`values.${i}.value`, 'duplicate');
      seen.add(v.value);
      if (!builtin.includes(v.value) && !EXTENSIBLE.has(field)) add(`values.${i}.value`, 'not_allowed');
    } else {
      if (!EXTENSIBLE.has(field)) add(`values.${i}.value`, 'not_allowed');
      if (!v.label) add(`values.${i}.label`, 'required');
    }
    if (v.label) {
      const key = v.label.toLowerCase();
      if (labels.has(key)) add(`values.${i}.label`, 'taken');
      labels.add(key);
    }
    if (v.value && LOCKED[field].includes(v.value) && !v.isActive) add(`values.${i}.isActive`, 'locked');
    const open = field === PicklistField.DEAL_STAGE && v.value !== undefined && v.value in DEFAULT_PROBABILITY;
    if (v.probability !== undefined && v.probability !== null && !open) add(`values.${i}.probability`, 'not_allowed');
  }
  // 内置选项不能删除；没有扩展能力的字段顺序固定 / built-ins stay; fixed order for non-extensible fields
  for (const b of builtin) if (!seen.has(b)) add('values', `missing:${b}`);
  if (!EXTENSIBLE.has(field)) {
    const order = input.values.map((v) => v.value);
    if (order.join() !== builtin.join()) add('values', 'order_fixed');
  }
  if (!input.values.some((v) => v.isActive)) add('values', 'none_active');
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid options', errors);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`picklist:${ctx.organizationId}:${field}`}, 0))`;
    const before = await getPicklist(ctx.organizationId, field, tx);
    // 删除的自定义选项不能被记录使用 / removed custom options must be unused
    for (const old of before.filter((o) => o.isCustom && !seen.has(o.value))) {
      const n = await usage(tx, ctx.organizationId, field, old.value);
      if (n) throw new ApiError(409, 'CONFLICT', 'Option in use', { values: [`in_use:${old.value}`] });
    }
    // 新选项的代码：随机生成，避免与现有代码冲突 / codes for new options: random, never clashing
    const taken = new Set([...before.map((o) => o.value), ...seen]);
    const rows = input.values.map((v, position) => {
      let value = v.value;
      while (!value || (!v.value && taken.has(value))) value = `C_${randomBytes(4).toString('hex').toUpperCase()}`;
      taken.add(value);
      const open = field === PicklistField.DEAL_STAGE && value in DEFAULT_PROBABILITY;
      return { organizationId: ctx.organizationId, field, value, label: v.label, position, isActive: v.isActive, probability: open ? (v.probability ?? DEFAULT_PROBABILITY[value]!) : null };
    });
    await tx.picklistValue.deleteMany({ where: { organizationId: ctx.organizationId, field } });
    await tx.picklistValue.createMany({ data: rows });
    const after = await getPicklist(ctx.organizationId, field, tx);
    const brief = (list: PicklistOption[]) => list.map((o) => ({ value: o.value, label: o.label, isActive: o.isActive, probability: o.probability }));
    await audit(tx, { ...by(ctx), action: 'picklist.update', entityType: 'picklist', entityId: ctx.organizationId, changes: { field, before: brief(before), after: brief(after) } });
    return after;
  });
}

/**
 * 记录写入时检查选项：必须存在且启用；与原值相同时允许（已停用的旧值可保留）。
 * Check an option on record writes: it must exist and be active; unchanged values pass (inactive old values stay).
 * @param key 出错时的字段名 / field name for the error
 */
export async function assertOption(organizationId: string, field: PicklistField, value: string | null | undefined, current: string | null | undefined, key: string): Promise<void> {
  if (value === undefined || value === null || value === current) return;
  const option = (await getPicklist(organizationId, field)).find((o) => o.value === value);
  if (!option) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid option', { [key]: ['invalid_option'] });
  if (!option.isActive) throw new ApiError(400, 'VALIDATION_ERROR', 'Inactive option', { [key]: ['inactive_option'] });
}

/**
 * 进行中商机阶段的赢单概率（%）。
 * Win probability (%) of the open deal stages.
 */
export async function openStageProbabilities(organizationId: string): Promise<Record<string, number>> {
  const list = await getPicklist(organizationId, PicklistField.DEAL_STAGE);
  return Object.fromEntries(list.filter((o) => o.value in DEFAULT_PROBABILITY).map((o) => [o.value, o.probability ?? DEFAULT_PROBABILITY[o.value]!]));
}

/**
 * 全部商机阶段的赢单概率（%，已结束阶段固定为 100 与 0）。
 * Win probability (%) of every deal stage (closed stages fixed at 100 and 0).
 */
export async function stageProbabilities(organizationId: string): Promise<Record<string, number>> {
  return { ...(await openStageProbabilities(organizationId)), ...CLOSED_PROBABILITY };
}

/**
 * 第一个启用的进行中商机阶段（新建商机未指定阶段时使用）。
 * The first active open deal stage (used when a new deal names none).
 */
export async function firstActiveOpenStage(organizationId: string): Promise<string> {
  const list = await getPicklist(organizationId, PicklistField.DEAL_STAGE);
  return list.find((o) => o.isActive && o.value in DEFAULT_PROBABILITY)?.value ?? DealStage.QUALIFICATION;
}

/** 规则中引用的选项 / an option referenced by a rule */
export interface OptionRef {
  /** 记录字段名（source 或 industry）/ record field (source or industry) */
  field: string;
  value: string;
  /** 出错时的路径 / error path */
  key: string;
}
/** 可扩展字段对应的下拉字段 / picklist behind each extensible field */
const EXTENSIBLE_FIELD: Record<string, PicklistField> = { source: PicklistField.LEAD_SOURCE, industry: PicklistField.INDUSTRY };

/**
 * 规则（评分、分配、区域、工作流、验证规则、宏）引用的线索来源与行业须是本组织配置中的选项（已停用的也可引用，
 * 使旧规则仍可保存）；其他字段不在此检查。
 * Lead sources and industries referenced by rules (scoring, assignment, territories, workflows, validation rules,
 * macros) must exist in the organization's setup (inactive ones too, so older rules still save); other fields are
 * not checked here.
 */
export async function assertKnownOptions(organizationId: string, refs: OptionRef[]): Promise<void> {
  const errors: Record<string, string[]> = {};
  const lists = new Map<PicklistField, Set<string>>();
  for (const r of refs) {
    const field = EXTENSIBLE_FIELD[r.field];
    if (!field) continue;
    if (!lists.has(field)) lists.set(field, new Set((await getPicklist(organizationId, field)).map((o) => o.value)));
    if (!lists.get(field)!.has(r.value)) (errors[r.key] ??= []).push('invalid_option');
  }
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown option', errors);
}

/**
 * 给导出用的枚举翻译加上组织自定义的选项名称（服务端不使用浏览器中的全局覆盖，按请求的组织读取）。
 * Wrap an export's enum translator with the organization's custom option labels (the server never uses the browser's
 * global overrides; labels are read per request organization).
 */
export async function withOptionLabels(organizationId: string, tEnum: (prefix: string, value: string | null | undefined) => string) {
  const rows = await prisma.picklistValue.findMany({ where: { organizationId, label: { not: null } }, select: { field: true, value: true, label: true } });
  const labels = new Map(rows.map((r) => [`${I18N_PREFIX[r.field]}.${r.value}`, r.label!]));
  return (prefix: string, value: string | null | undefined) => (value ? (labels.get(`${prefix}.${value}`) ?? tEnum(prefix, value)) : tEnum(prefix, value));
}

/**
 * 在记录写入的事务内锁定并复核自定义选项：与删除选项（持有同一键的排他锁）互斥，避免记录引用已删除的选项。
 * 内置选项不能删除，无需加锁。
 * Inside a record write transaction, lock (shared) and re-check a custom option: exclusive with removing options
 * (which holds the exclusive lock on the same key), so records never reference a removed option. Built-ins cannot be
 * removed and need no lock.
 * @param key 出错时的字段名 / field name for the error
 */
export async function lockCustomOption(tx: Prisma.TransactionClient, organizationId: string, field: PicklistField, value: string | null | undefined, key: string): Promise<void> {
  if (!value || BUILTIN[field].includes(value)) return;
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock_shared(hashtextextended(${`picklist:${organizationId}:${field}`}, 0))`;
  if (!(await tx.picklistValue.count({ where: { organizationId, field, value } }))) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid option', { [key]: ['invalid_option'] });
}
