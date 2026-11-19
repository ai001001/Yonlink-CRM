/**
 * 工作流规则（对标 Zoho Workflow Rules）：线索、商机新建或编辑时，按触发时机与条件自动执行动作。
 * - 触发时机：新建时、编辑时（有字段变化）、新建或编辑时、指定字段变化时（线索：状态、来源、负责人、市场活动；
 *   商机：阶段、金额、币种、负责人、预计成交日）。
 * - 条件（最多 5 条，全部满足，按记录写入后的值判断）：枚举等于/不等于；文本等于、包含、开头是、结尾是、为空、不为空；
 *   数字（金额、评分）不小于/不大于；负责人、市场活动等于、为空、不为空。
 * - 动作（1–5 个，按顺序执行）：更新字段（线索状态、来源；商机阶段）、指派负责人、创建任务（关联记录，N 天后到期，
 *   分配给记录负责人或指定用户）、站内通知（记录负责人或指定用户）、加标签。
 * - 执行：在触发写入的同一事务内、按规则创建顺序依次执行；后面的规则看到前面规则的改动。工作流做出的改动不会再触发工作流
 *   （防止循环）。动作以系统身份执行，不受触发人权限限制；目标用户已停用、标签已删除、已转化线索改状态等情况跳过该动作
 *   并在审计中注明，不影响触发的写入。每次执行写一条 workflow.run 审计，字段更新与指派另在记录上写审计。
 * - 维护：所有用户可查看；新建、修改、启停、删除需 workflow.manage（管理员、经理）并写审计。每个组织最多 100 条规则。
 * - 触发来源：线索、商机的新建与编辑（含批量操作、看板拖动）以及网页表单生成的线索；导入、线索转化生成的商机不触发。
 * Workflow rules (cf. Zoho Workflow Rules): when a lead or deal is created or edited, run actions automatically by
 * trigger and conditions. Triggers: create, edit (some field changed), create or edit, or a given field changes.
 * Up to 5 conditions (all must hold, on the written values). 1–5 actions in order: field update, assign owner, create
 * task, in-app notification, add tag. Runs inside the triggering transaction in rule creation order; later rules see
 * earlier changes; changes made by workflows never trigger workflows. Actions run as the system; unusable targets
 * (inactive users, deleted tags, status of converted leads) are skipped and noted in the audit without failing the
 * write. Each run writes a workflow.run audit entry; field updates and assignments are also audited on the record.
 * Everyone can read rules; maintenance needs workflow.manage (admins, managers) and is audited; at most 100 rules per
 * organization. Fired by lead/deal create and edit (bulk and board included) and web-form leads; imports and deals
 * created by lead conversion do not fire.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { DealStage, LeadStatus, NotificationType, WorkflowEntity, WorkflowTrigger } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { requiredText, type Page } from '../validation';
import { CURRENCIES, LEAD_SOURCES } from './dictionaries';

/** 每组织最多规则数 / max rules per organization */
export const MAX_WORKFLOWS = 100;

type FieldType = 'enum' | 'text' | 'number' | 'id';
interface FieldDef {
  type: FieldType;
  values?: readonly string[];
}

/** 可作为条件的字段 / condition fields per entity */
export const CONDITION_FIELDS: Record<WorkflowEntity, Record<string, FieldDef>> = {
  LEAD: {
    status: { type: 'enum', values: Object.values(LeadStatus) },
    source: { type: 'enum', values: LEAD_SOURCES },
    name: { type: 'text' },
    company: { type: 'text' },
    title: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    description: { type: 'text' },
    score: { type: 'number' },
    ownerId: { type: 'id' },
    campaignId: { type: 'id' },
  },
  DEAL: {
    stage: { type: 'enum', values: Object.values(DealStage) },
    currency: { type: 'enum', values: CURRENCIES },
    name: { type: 'text' },
    description: { type: 'text' },
    amount: { type: 'number' },
    score: { type: 'number' },
    ownerId: { type: 'id' },
    campaignId: { type: 'id' },
  },
};

/** 可作为“指定字段变化”触发的字段 / fields usable for FIELD_CHANGE */
export const TRIGGER_FIELDS: Record<WorkflowEntity, readonly string[]> = {
  LEAD: ['status', 'source', 'ownerId', 'campaignId'],
  DEAL: ['stage', 'amount', 'currency', 'ownerId', 'expectedCloseDate'],
};

/** 编辑时比较的字段 / fields compared for "edit" */
const TRACKED: Record<WorkflowEntity, readonly string[]> = {
  LEAD: ['name', 'company', 'title', 'phone', 'mobile', 'email', 'source', 'status', 'description', 'ownerId', 'campaignId'],
  DEAL: ['name', 'accountId', 'amount', 'currency', 'stage', 'expectedCloseDate', 'description', 'ownerId', 'campaignId'],
};

/** 可由动作更新的字段与取值 / fields an action may update, with allowed values */
export const UPDATE_FIELDS: Record<WorkflowEntity, Record<string, readonly string[]>> = {
  LEAD: { status: Object.values(LeadStatus).filter((s) => s !== LeadStatus.CONVERTED), source: LEAD_SOURCES },
  DEAL: { stage: Object.values(DealStage) },
};

const OPS: Record<FieldType, readonly string[]> = {
  enum: ['EQUALS', 'NOT_EQUALS'],
  text: ['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'IS_EMPTY', 'NOT_EMPTY'],
  number: ['GTE', 'LTE'],
  id: ['EQUALS', 'IS_EMPTY', 'NOT_EMPTY'],
};
const NO_VALUE = new Set(['IS_EMPTY', 'NOT_EMPTY']);

const conditionSchema = z.strictObject({ field: z.string().max(30), op: z.string().max(20), value: z.string().trim().max(200).optional() });
export type Condition = z.infer<typeof conditionSchema>;

const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('UPDATE_FIELD'), field: z.string().max(30), value: z.string().max(30) }),
  z.strictObject({ type: z.literal('ASSIGN_OWNER'), userId: z.uuid() }),
  z.strictObject({ type: z.literal('CREATE_TASK'), subject: requiredText(200), dueInDays: z.number().int().min(0).max(365), assignTo: z.union([z.literal('OWNER'), z.uuid()]) }),
  z.strictObject({ type: z.literal('NOTIFY'), recipient: z.union([z.literal('OWNER'), z.uuid()]), message: requiredText(150) }),
  z.strictObject({ type: z.literal('ADD_TAG'), tagId: z.uuid() }),
]);
export type Action = z.infer<typeof actionSchema>;

const ruleFields = {
  name: requiredText(100),
  entity: z.enum(WorkflowEntity),
  trigger: z.enum(WorkflowTrigger),
  triggerField: z.string().max(30).nullish().transform((v) => v ?? null),
  conditions: z.array(conditionSchema).max(5).default([]),
  actions: z.array(actionSchema).min(1).max(5),
  isActive: z.boolean().default(true),
};

/**
 * 按对象校验触发字段、条件与动作（字段、比较方式与取值必须属于该对象的固定集合）。
 * Validate trigger field, conditions and actions per entity (fields, operators and values from fixed sets).
 */
function checkRule(v: { entity: WorkflowEntity; trigger: WorkflowTrigger; triggerField: string | null; conditions: Condition[]; actions: Action[] }, ctx: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (v.trigger === WorkflowTrigger.FIELD_CHANGE) {
    if (!v.triggerField || !TRIGGER_FIELDS[v.entity].includes(v.triggerField)) issue(['triggerField'], 'invalid_field');
  } else if (v.triggerField) issue(['triggerField'], 'not_allowed');
  v.conditions.forEach((c, i) => {
    const def = CONDITION_FIELDS[v.entity][c.field];
    if (!def) return issue(['conditions', i, 'field'], 'invalid_field');
    if (!OPS[def.type].includes(c.op)) return issue(['conditions', i, 'op'], 'invalid_op');
    if (NO_VALUE.has(c.op)) {
      if (c.value) issue(['conditions', i, 'value'], 'not_allowed');
      return;
    }
    const value = c.value ?? '';
    if (!value) return issue(['conditions', i, 'value'], 'required');
    if (def.type === 'enum' && !def.values!.includes(value)) issue(['conditions', i, 'value'], 'invalid_value');
    if (def.type === 'number' && !/^-?\d{1,16}(\.\d{1,2})?$/.test(value)) issue(['conditions', i, 'value'], 'invalid_number');
    if (def.type === 'id' && !z.uuid().safeParse(value).success) issue(['conditions', i, 'value'], 'invalid_id');
  });
  v.actions.forEach((a, i) => {
    if (a.type === 'UPDATE_FIELD') {
      const values = UPDATE_FIELDS[v.entity][a.field];
      if (!values) issue(['actions', i, 'field'], 'invalid_field');
      else if (!values.includes(a.value)) issue(['actions', i, 'value'], 'invalid_value');
    }
  });
}

/** 新建规则 / create a rule */
export const workflowCreateSchema = z.strictObject(ruleFields).superRefine(checkRule);
/** 修改规则（整体替换可编辑字段；对象不可改）/ update a rule (replaces editable fields; the entity cannot change) */
export const workflowUpdateSchema = z
  .strictObject({
    name: requiredText(100),
    entity: z.enum(WorkflowEntity),
    trigger: z.enum(WorkflowTrigger),
    triggerField: z.string().max(30).nullable(),
    conditions: z.array(conditionSchema).max(5),
    actions: z.array(actionSchema).min(1).max(5),
    isActive: z.boolean(),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.isActive !== undefined && Object.keys(v).length === 1) return; // 只启停 / toggle only
    if (!v.entity || !v.trigger || !v.actions) {
      ctx.addIssue({ code: 'custom', path: ['entity'], message: 'entity_trigger_actions_required' });
      return;
    }
    checkRule({ entity: v.entity, trigger: v.trigger, triggerField: v.triggerField ?? null, conditions: v.conditions ?? [], actions: v.actions }, ctx);
  });
/** 列表查询 / list query */
export const workflowListSchema = z.strictObject({
  entity: z.enum(WorkflowEntity).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const select = {
  id: true,
  name: true,
  entity: true,
  trigger: true,
  triggerField: true,
  conditions: true,
  actions: true,
  isActive: true,
  runCount: true,
  lastRunAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WorkflowRuleSelect;

/** 审计快照 / audit snapshot */
const snap = (r: { name: string; entity: string; trigger: string; triggerField: string | null; conditions: unknown; actions: unknown; isActive: boolean }) => ({
  name: r.name,
  entity: r.entity,
  trigger: r.trigger,
  triggerField: r.triggerField,
  conditions: r.conditions,
  actions: r.actions,
  isActive: r.isActive,
});

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Workflow name already exists', { name: ['taken'] });
  throw err;
}

/**
 * 动作引用的用户须为本组织启用用户、标签须属于本组织。
 * Users referenced by actions must be active members; tags must belong to the organization.
 */
async function checkRefs(ctx: AuthContext, actions: Action[]): Promise<void> {
  const userIds = new Set<string>();
  const tagIds = new Set<string>();
  for (const a of actions) {
    if (a.type === 'ASSIGN_OWNER') userIds.add(a.userId);
    if (a.type === 'CREATE_TASK' && a.assignTo !== 'OWNER') userIds.add(a.assignTo);
    if (a.type === 'NOTIFY' && a.recipient !== 'OWNER') userIds.add(a.recipient);
    if (a.type === 'ADD_TAG') tagIds.add(a.tagId);
  }
  const [users, tags] = await Promise.all([
    prisma.user.count({ where: { organizationId: ctx.organizationId, isActive: true, id: { in: [...userIds] } } }),
    prisma.tag.count({ where: { organizationId: ctx.organizationId, id: { in: [...tagIds] } } }),
  ]);
  const details: Record<string, string[]> = {};
  if (users !== userIds.size) details.actions = ['user_not_found'];
  if (tags !== tagIds.size) details.actions = [...(details.actions ?? []), 'tag_not_found'];
  if (Object.keys(details).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid workflow actions', details);
}

/**
 * 规则列表（按对象筛选，最新在前）。
 * List rules (optionally by entity, newest first).
 */
export async function listWorkflows(ctx: AuthContext, query: z.infer<typeof workflowListSchema>): Promise<Page<unknown>> {
  const where: Prisma.WorkflowRuleWhereInput = { organizationId: ctx.organizationId, entity: query.entity };
  const [items, total] = await prisma.$transaction([
    prisma.workflowRule.findMany({ where, select, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.workflowRule.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 新建规则。
 * Create a rule.
 */
export async function createWorkflow(ctx: AuthContext, input: z.infer<typeof workflowCreateSchema>) {
  requirePermission(ctx, 'workflow.manage');
  await checkRefs(ctx, input.actions);
  try {
    return await prisma.$transaction(async (tx) => {
      // 每组织上限：同一组织的新建串行判断 / per-organization cap, checked under a lock
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`workflow:${ctx.organizationId}`}, 0))`;
      if ((await tx.workflowRule.count({ where: { organizationId: ctx.organizationId } })) >= MAX_WORKFLOWS) {
        throw new ApiError(409, 'CONFLICT', 'Too many workflow rules', { name: ['limit_reached'] });
      }
      const rule = await tx.workflowRule.create({ data: { ...input, organizationId: ctx.organizationId, createdById: ctx.userId }, select });
      await audit(tx, { ...by(ctx), action: 'workflow.create', entityType: 'workflow', entityId: rule.id, changes: { after: snap(rule) } });
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
export async function updateWorkflow(ctx: AuthContext, id: string, input: z.infer<typeof workflowUpdateSchema>) {
  requirePermission(ctx, 'workflow.manage');
  const current = await prisma.workflowRule.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  if (input.entity && input.entity !== current.entity) throw new ApiError(400, 'VALIDATION_ERROR', 'Entity cannot change', { entity: ['immutable'] });
  if (input.actions) await checkRefs(ctx, input.actions);
  const { entity: _entity, ...data } = input;
  void _entity;
  try {
    return await prisma.$transaction(async (tx) => {
      const rule = await tx.workflowRule.update({ where: { id }, data: { ...data, triggerField: input.trigger ? (input.triggerField ?? null) : undefined }, select });
      const before = snap(current);
      const after = snap(rule);
      const fields = Object.fromEntries(
        (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, [before[k], after[k]]]),
      );
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'workflow.update', entityType: 'workflow', entityId: id, changes: { fields } });
      return rule;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除规则（已执行的动作结果保留）。
 * Delete a rule (results of past runs stay).
 */
export async function deleteWorkflow(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'workflow.manage');
  const current = await prisma.workflowRule.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!current) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.workflowRule.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'workflow.delete', entityType: 'workflow', entityId: id, changes: { before: { ...snap(current), runCount: current.runCount } } });
  });
}

// ---------------------------------------------------------------------------
// 执行 / execution

/** 触发事件 / a triggering event */
export interface WorkflowEvent {
  entity: WorkflowEntity;
  /** 写入前的记录；新建时为 null / the record before the write; null on create */
  before: Record<string, unknown> | null;
  /** 写入后的记录 / the record after the write */
  after: Record<string, unknown> & { id: string; organizationId: string; name: string; ownerId: string | null };
  /** 触发人（网页表单等系统写入为 null）/ the actor (null for system writes such as web forms) */
  actorId: string | null;
  meta?: AuthContext['meta'];
}

/** 比较用的值（Decimal、日期转字符串）/ comparable value (Decimal and dates as strings) */
function norm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Prisma.Decimal.isDecimal(v)) return new Prisma.Decimal(v as Prisma.Decimal).toString();
  return String(v);
}

/**
 * 单个条件是否成立（按写入后的值）。
 * Whether one condition holds on the written values.
 */
export function conditionHolds(entity: WorkflowEntity, c: Condition, record: Record<string, unknown>): boolean {
  const def = CONDITION_FIELDS[entity][c.field];
  if (!def) return false;
  const raw = record[c.field];
  const actual = norm(raw);
  if (c.op === 'IS_EMPTY') return actual === null || actual.trim() === '';
  if (c.op === 'NOT_EMPTY') return actual !== null && actual.trim() !== '';
  const value = c.value ?? '';
  if (def.type === 'number') {
    if (actual === null) return false;
    const a = new Prisma.Decimal(actual);
    return c.op === 'GTE' ? a.gte(value) : a.lte(value);
  }
  if (def.type === 'text') {
    const a = (actual ?? '').trim().toLowerCase();
    const e = value.trim().toLowerCase();
    if (!a) return false;
    if (c.op === 'EQUALS') return a === e;
    if (c.op === 'CONTAINS') return a.includes(e);
    if (c.op === 'STARTS_WITH') return a.startsWith(e);
    return a.endsWith(e);
  }
  if (c.op === 'NOT_EQUALS') return actual !== value;
  return actual === value;
}

/** 规则是否被本次事件触发 / whether the event fires a rule */
function fires(rule: { entity: WorkflowEntity; trigger: WorkflowTrigger; triggerField: string | null }, ev: WorkflowEvent): boolean {
  const created = ev.before === null;
  const changed = (f: string) => !created && norm(ev.before![f]) !== norm(ev.after[f]);
  switch (rule.trigger) {
    case WorkflowTrigger.CREATE:
      return created;
    case WorkflowTrigger.UPDATE:
      return TRACKED[rule.entity].some(changed);
    case WorkflowTrigger.CREATE_OR_UPDATE:
      return created || TRACKED[rule.entity].some(changed);
    case WorkflowTrigger.FIELD_CHANGE:
      return !!rule.triggerField && changed(rule.triggerField);
  }
}

/** 本组织启用的用户 / an active member of the organization */
async function activeUser(tx: Prisma.TransactionClient, organizationId: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const u = await tx.user.findFirst({ where: { id, organizationId, isActive: true }, select: { id: true } });
  return u?.id ?? null;
}

/**
 * 执行本次事件触发的工作流（在触发写入的事务内调用）。
 * Run the workflows fired by an event (call inside the triggering transaction).
 * @returns 执行的规则数 / number of rules run
 */
export async function runWorkflows(tx: Prisma.TransactionClient, ev: WorkflowEvent): Promise<number> {
  const org = ev.after.organizationId;
  const rules = await tx.workflowRule.findMany({ where: { organizationId: org, entity: ev.entity, isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!rules.length) return 0;
  const record: Record<string, unknown> & { id: string; name: string; ownerId: string | null } = { ...ev.after };
  const target = ev.entity === WorkflowEntity.LEAD ? { leadId: record.id } : { dealId: record.id };
  const auditEntity = ev.entity === WorkflowEntity.LEAD ? 'lead' : 'deal';
  let ran = 0;
  for (const rule of rules) {
    if (!fires(rule, ev)) continue;
    const conditions = z.array(conditionSchema).safeParse(rule.conditions);
    const actions = z.array(actionSchema).safeParse(rule.actions);
    if (!conditions.success || !actions.success) continue; // 防御：保存时已校验 / defensive; validated on save
    if (!conditions.data.every((c) => conditionHolds(ev.entity, c, record))) continue;
    const done: string[] = [];
    const skipped: string[] = [];
    for (const a of actions.data) {
      switch (a.type) {
        case 'UPDATE_FIELD': {
          if (ev.entity === WorkflowEntity.LEAD && a.field === 'status' && record.convertedAt) {
            skipped.push(`UPDATE_FIELD ${a.field}: converted`);
            break;
          }
          const before = norm(record[a.field]);
          if (before === a.value) {
            done.push(`UPDATE_FIELD ${a.field}=${a.value} (unchanged)`);
            break;
          }
          if (ev.entity === WorkflowEntity.LEAD) await tx.lead.update({ where: { id: record.id }, data: { [a.field]: a.value } });
          else await tx.deal.update({ where: { id: record.id }, data: { [a.field]: a.value } });
          record[a.field] = a.value;
          await audit(tx, { organizationId: org, actorId: ev.actorId, action: `${auditEntity}.update`, entityType: auditEntity, entityId: record.id, changes: { fields: { [a.field]: [before, a.value] }, workflow: rule.name }, meta: ev.meta });
          done.push(`UPDATE_FIELD ${a.field}=${a.value}`);
          break;
        }
        case 'ASSIGN_OWNER': {
          const user = await activeUser(tx, org, a.userId);
          if (!user) {
            skipped.push('ASSIGN_OWNER: user_inactive');
            break;
          }
          const previous = record.ownerId;
          if (previous === user) {
            done.push('ASSIGN_OWNER (unchanged)');
            break;
          }
          if (ev.entity === WorkflowEntity.LEAD) await tx.lead.update({ where: { id: record.id }, data: { ownerId: user } });
          else await tx.deal.update({ where: { id: record.id }, data: { ownerId: user } });
          record.ownerId = user;
          await audit(tx, { organizationId: org, actorId: ev.actorId, action: `${auditEntity}.update`, entityType: auditEntity, entityId: record.id, changes: { fields: { ownerId: [previous, user] }, workflow: rule.name }, meta: ev.meta });
          if (user !== ev.actorId) {
            await tx.notification.create({ data: { organizationId: org, userId: user, type: NotificationType.ASSIGNED, actorId: ev.actorId, ...target, title: record.name.slice(0, 200) } });
          }
          done.push('ASSIGN_OWNER');
          break;
        }
        case 'CREATE_TASK': {
          const owner = a.assignTo === 'OWNER' ? record.ownerId : await activeUser(tx, org, a.assignTo);
          if (a.assignTo !== 'OWNER' && !owner) skipped.push('CREATE_TASK: user_inactive → owner');
          const dueAt = new Date(Date.now() + a.dueInDays * 86_400_000);
          const task = await tx.activity.create({
            data: { organizationId: org, type: 'TASK', subject: a.subject, dueAt, ownerId: owner ?? record.ownerId, ...target },
          });
          await audit(tx, { organizationId: org, actorId: ev.actorId, action: 'activity.create', entityType: 'activity', entityId: task.id, changes: { after: { type: 'TASK', subject: a.subject, ownerId: task.ownerId }, workflow: rule.name }, meta: ev.meta });
          done.push('CREATE_TASK');
          break;
        }
        case 'NOTIFY': {
          const to = a.recipient === 'OWNER' ? record.ownerId : await activeUser(tx, org, a.recipient);
          if (!to) {
            skipped.push(`NOTIFY: ${a.recipient === 'OWNER' ? 'no_owner' : 'user_inactive'}`);
            break;
          }
          await tx.notification.create({ data: { organizationId: org, userId: to, type: NotificationType.WORKFLOW, actorId: ev.actorId, ...target, title: `${a.message} · ${record.name}`.slice(0, 200) } });
          done.push('NOTIFY');
          break;
        }
        case 'ADD_TAG': {
          const tag = await tx.tag.findFirst({ where: { id: a.tagId, organizationId: org }, select: { id: true } });
          if (!tag) {
            skipped.push('ADD_TAG: tag_deleted');
            break;
          }
          if (ev.entity === WorkflowEntity.LEAD) await tx.leadTag.createMany({ data: [{ organizationId: org, leadId: record.id, tagId: tag.id }], skipDuplicates: true });
          else await tx.dealTag.createMany({ data: [{ organizationId: org, dealId: record.id, tagId: tag.id }], skipDuplicates: true });
          done.push('ADD_TAG');
          break;
        }
      }
    }
    await tx.workflowRule.update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
    await audit(tx, {
      organizationId: org,
      actorId: ev.actorId,
      action: 'workflow.run',
      entityType: 'workflow',
      entityId: rule.id,
      changes: { rule: rule.name, entity: ev.entity, recordId: record.id, record: record.name, actions: done, ...(skipped.length ? { skipped } : {}) },
      meta: ev.meta,
    });
    ran += 1;
  }
  return ran;
}
