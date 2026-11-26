/**
 * 字段验证规则（对标 Zoho Validation Rules）：线索、商机满足“适用条件”时，必须满足“要求”，否则拒绝保存并提示自定义信息。
 * - 条件与工作流相同（枚举、文本、数字、负责人、市场活动），另支持手机（线索）与预计成交日（商机，为空/不为空/≥/≤ 日期）；
 *   不含评分（评分在写入后才计算）。适用条件为空表示总是适用。
 * - 校验时机：线索、商机的新建与编辑（含批量操作、看板拖动、API 密钥调用），按写入后的值判断；不满足的规则全部列出，
 *   提示显示在指定字段下（未指定则在表单顶部）。网页表单、导入、线索转化与工作流做出的系统改动不校验。
 * - 维护：所有用户可查看；新建、修改、启停、删除需 validation.manage（管理员、经理）并写审计；每组织最多 50 条。
 * Validation rules (cf. Zoho Validation Rules): when a lead or deal meets the "when" conditions it must meet the
 * "require" conditions, or the save is refused with a custom message. Conditions match workflows (enums, text, numbers,
 * owner, campaign) plus mobile (leads) and expected close date (deals: empty / not empty / ≥ / ≤ a date); no score
 * (computed after the write). Empty "when" means always. Checked on lead and deal create and edit (bulk, board and API
 * keys included) against the written values; every failing rule is listed, shown under the chosen field (or at the top).
 * Web forms, imports, lead conversion and workflow changes are not checked. Everyone can read; maintenance needs
 * validation.manage (admins, managers) and is audited; at most 50 rules per organization.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { requiredText } from '../validation';
import { checkCondition, CONDITION_FIELDS, conditionSchema, evaluate, optionRefs, type Condition, type FieldDef } from './workflows';
import { assertKnownOptions } from './picklists';
import { RECORD_ENTITIES, type RecordEntity } from './dictionaries';

/** 每组织最多规则数 / max rules per organization */
export const MAX_VALIDATION_RULES = 50;

/** 去掉评分（写入后才计算）/ drop the score (computed after the write) */
const withoutScore = (f: Record<string, FieldDef>) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'score'));

/** 可用于验证规则的字段 / fields usable in validation rules */
export const VALIDATION_FIELDS: Record<RecordEntity, Record<string, FieldDef>> = {
  LEAD: { ...withoutScore(CONDITION_FIELDS.LEAD), mobile: { type: 'text' } },
  DEAL: { ...withoutScore(CONDITION_FIELDS.DEAL), expectedCloseDate: { type: 'date' } },
};

const ruleFields = {
  name: requiredText(100),
  entity: z.enum(RECORD_ENTITIES),
  when: z.array(conditionSchema).max(5).default([]),
  require: z.array(conditionSchema).min(1).max(5),
  message: requiredText(200),
  errorField: z.string().max(30).nullish().transform((v) => v ?? null),
  isActive: z.boolean().default(true),
};

/** 按对象校验条件与提示字段 / validate conditions and the error field per entity */
function checkRule(v: { entity: RecordEntity; when: Condition[]; require: Condition[]; errorField: string | null }, ctx: z.RefinementCtx) {
  const fields = VALIDATION_FIELDS[v.entity];
  for (const key of ['when', 'require'] as const) {
    v[key].forEach((c, i) => checkCondition(fields, c, (field, message) => ctx.addIssue({ code: 'custom', path: [key, i, field], message })));
  }
  if (v.errorField && !fields[v.errorField]) ctx.addIssue({ code: 'custom', path: ['errorField'], message: 'invalid_field' });
}

/** 新建 / create */
export const validationCreateSchema = z.strictObject(ruleFields).superRefine(checkRule);
/** 修改（只启停，或整体替换；对象不可改）/ update (toggle only, or replace; the entity is fixed) */
export const validationUpdateSchema = z
  .strictObject({
    name: requiredText(100),
    entity: z.enum(RECORD_ENTITIES),
    when: z.array(conditionSchema).max(5),
    require: z.array(conditionSchema).min(1).max(5),
    message: requiredText(200),
    errorField: z.string().max(30).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.isActive !== undefined && Object.keys(v).length === 1) return;
    if (!v.entity || !v.require || !v.name || !v.message) {
      ctx.addIssue({ code: 'custom', path: ['entity'], message: 'entity_require_name_message_required' });
      return;
    }
    checkRule({ entity: v.entity, when: v.when ?? [], require: v.require, errorField: v.errorField ?? null }, ctx);
  });
/** 列表 / list */
export const validationListSchema = z.strictObject({ entity: z.enum(RECORD_ENTITIES).optional() });

const select = {
  id: true,
  name: true,
  entity: true,
  when: true,
  require: true,
  message: true,
  errorField: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ValidationRuleSelect;

/** 审计快照 / audit snapshot */
const snap = (r: { name: string; entity: string; when: unknown; require: unknown; message: string; errorField: string | null; isActive: boolean }) => ({
  name: r.name,
  entity: r.entity,
  when: r.when,
  require: r.require,
  message: r.message,
  errorField: r.errorField,
  isActive: r.isActive,
});

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Validation rule name already exists', { name: ['taken'] });
  throw err;
}

/**
 * 规则列表（按对象筛选，按创建顺序）。
 * List rules (optionally by entity) in creation order.
 */
export async function listValidationRules(ctx: AuthContext, query: z.infer<typeof validationListSchema>) {
  return { items: await prisma.validationRule.findMany({ where: { organizationId: ctx.organizationId, entity: query.entity }, select, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) };
}

/**
 * 新建规则（同一组织串行判断上限）。
 * Create a rule (the per-organization cap is checked under a lock).
 */
export async function createValidationRule(ctx: AuthContext, input: z.infer<typeof validationCreateSchema>) {
  requirePermission(ctx, 'validation.manage');
  // 引用的线索来源须为本组织的选项 / referenced lead sources must be the organization's options
  await assertKnownOptions(ctx.organizationId, [...optionRefs(input.when, [], 'when'), ...optionRefs(input.require, [], 'require')]);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`validation:${ctx.organizationId}`}, 0))`;
      if ((await tx.validationRule.count({ where: { organizationId: ctx.organizationId } })) >= MAX_VALIDATION_RULES) {
        throw new ApiError(409, 'CONFLICT', 'Too many validation rules', { name: ['limit_reached'] });
      }
      const rule = await tx.validationRule.create({ data: { ...input, organizationId: ctx.organizationId, createdById: ctx.userId }, select });
      await audit(tx, { ...by(ctx), action: 'validation.create', entityType: 'validation', entityId: rule.id, changes: { after: snap(rule) } });
      return rule;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 修改规则（含只启停）。
 * Update a rule (including toggling only).
 */
export async function updateValidationRule(ctx: AuthContext, id: string, input: z.infer<typeof validationUpdateSchema>) {
  requirePermission(ctx, 'validation.manage');
  const current = await prisma.validationRule.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  await assertKnownOptions(ctx.organizationId, [...optionRefs(input.when, [], 'when'), ...optionRefs(input.require, [], 'require')]);
  if (input.entity && input.entity !== current.entity) throw new ApiError(400, 'VALIDATION_ERROR', 'Entity cannot change', { entity: ['immutable'] });
  const { entity: _entity, ...data } = input;
  void _entity;
  try {
    return await prisma.$transaction(async (tx) => {
      const rule = await tx.validationRule.update({ where: { id }, data, select });
      const before = snap(current);
      const after = snap(rule);
      const fields = Object.fromEntries((Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, [before[k], after[k]]]));
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'validation.update', entityType: 'validation', entityId: id, changes: { fields } });
      return rule;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除规则。
 * Delete a rule.
 */
export async function deleteValidationRule(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'validation.manage');
  const current = await prisma.validationRule.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.validationRule.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'validation.delete', entityType: 'validation', entityId: id, changes: { before: snap(current) } });
  });
}

/**
 * 按启用的规则校验写入后的记录；不满足时 400，列出全部提示（按提示字段归类，未指定的归入 rule）。
 * Check the record as written against the active rules; on failure 400 listing every message (grouped by the error
 * field, or under "rule").
 */
export async function assertValidRecord(organizationId: string, entity: RecordEntity, record: Record<string, unknown>): Promise<void> {
  const rules = await prisma.validationRule.findMany({ where: { organizationId, entity, isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!rules.length) return;
  const fields = VALIDATION_FIELDS[entity];
  const details: Record<string, string[]> = {};
  const messages: string[] = [];
  for (const r of rules) {
    const when = z.array(conditionSchema).safeParse(r.when);
    const require = z.array(conditionSchema).safeParse(r.require);
    if (!when.success || !require.success) continue; // 防御：保存时已校验 / defensive; validated on save
    const applies = when.data.every((c) => evaluate(fields[c.field], c, record[c.field]));
    if (!applies || require.data.every((c) => evaluate(fields[c.field], c, record[c.field]))) continue;
    const key = r.errorField ?? 'rule';
    (details[key] ??= []).push(r.message);
    messages.push(r.message);
  }
  if (messages.length) throw new ApiError(400, 'VALIDATION_ERROR', messages.join('; '), details);
}
