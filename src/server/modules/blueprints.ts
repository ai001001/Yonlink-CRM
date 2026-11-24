/**
 * 流程蓝图（对标 Zoho Blueprint）：为线索状态或商机阶段定义可走的转换，启用后只能按转换推进。
 * - 转换：名称、可从哪些状态出发（1–10 个）、到达的状态、可执行的角色、执行时必须填写的字段（最多 5 个）、是否必须填写备注。
 *   每个蓝图 1–20 个转换；同一蓝图内转换名称不重复，同一出发状态到同一目标只能有一个转换。
 * - 每个对象同时只能有一个启用的蓝图；每组织最多 20 个蓝图。维护需 blueprint.manage（管理员、经理）并写审计。
 * - 启用后：编辑、批量、看板、宏、工作流、查重合并都不能直接修改受控字段（BLUEPRINT_CONTROLLED），新建记录不受限制，
 *   线索转化照常把状态改为已转化。
 * - 执行转换：记录须可见且可编辑；当前状态须是出发状态之一；执行人角色须在允许范围内；必填字段取提交的值或记录已有的值，
 *   都为空时拒绝（金额须大于 0）；只能提交转换要求的字段；要求备注时必须填写，备注写入记录的备注。
 *   修改沿用线索、商机的修改服务（验证规则、工作流、阶段历史照常），并在同一事务内锁定记录、确认状态未被并发修改。
 * Blueprints (cf. Zoho Blueprint): define the allowed transitions of lead status or deal stage; once active, records
 * move only through them. A transition has a name, 1–10 source states, a target state, allowed roles, fields to fill
 * (at most 5) and an optional required note; 1–20 transitions per blueprint with unique names and at most one
 * transition per source→target. One active blueprint per entity and at most 20 per organization; maintenance needs
 * blueprint.manage (admins, managers) and is audited. While active, edits, bulk actions, the board, macros, workflows
 * and merges cannot change the controlled field (BLUEPRINT_CONTROLLED); creating records is unaffected and lead
 * conversion still sets the converted status. Running a transition requires a visible, editable record in a source
 * state and an allowed role; required fields take the submitted or existing value and must not be empty (amounts
 * above 0); only the transition's fields may be sent; a required note is saved as a record note. The change reuses the
 * lead and deal update services (validation rules, workflows, stage history) and locks the row to detect concurrent
 * state changes.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { DealStage, LeadStatus, UserRole, WorkflowEntity } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, requirePermission } from '../permissions';
import { optionalText, requiredText } from '../validation';
import { activeBlueprint, BLUEPRINT_FIELD } from './blueprint-rules';
import { dealUpdateSchema, getDeal, updateDeal } from './deals';
import { getLead, leadUpdateSchema, updateLead } from './leads';
import { createNote } from './notes';
import { asRecordEntity, RECORD_ENTITIES, type RecordEntity } from './dictionaries';

/** 每组织最多蓝图数 / max blueprints per organization */
export const MAX_BLUEPRINTS = 20;
/** 各对象的状态（线索不含已转化）/ states per entity (leads exclude converted) */
export const BLUEPRINT_STATES: Record<RecordEntity, readonly string[]> = {
  LEAD: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED'],
  DEAL: Object.values(DealStage),
};
/** 转换时可要求填写的字段 / fields a transition may require */
export const BLUEPRINT_FIELDS: Record<RecordEntity, readonly string[]> = {
  LEAD: ['company', 'title', 'phone', 'email', 'description'],
  DEAL: ['amount', 'expectedCloseDate', 'description'],
};
/** 转换字段的取值校验（沿用修改的校验）/ value schemas for transition fields (same as updates) */
const FIELD_SCHEMAS = {
  LEAD: leadUpdateSchema.pick({ company: true, title: true, phone: true, email: true, description: true }),
  DEAL: dealUpdateSchema.pick({ amount: true, expectedCloseDate: true, description: true }),
};

/** 转换 / transition */
export const transitionSchema = z.strictObject({
  id: z.uuid().optional(),
  name: requiredText(50),
  from: z.array(z.string().max(30)).min(1).max(10),
  to: z.string().max(30),
  roles: z.array(z.enum(UserRole).exclude([UserRole.READONLY])).min(1).max(3),
  fields: z.array(z.string().max(30)).max(5).default([]),
  noteRequired: z.boolean().default(false),
});
export type Transition = Required<z.infer<typeof transitionSchema>>;

/** 按对象校验转换 / validate transitions per entity */
function checkTransitions(entity: RecordEntity, transitions: z.infer<typeof transitionSchema>[], ctx: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const states = BLUEPRINT_STATES[entity];
  const names = new Set<string>();
  const ids = new Set<string>();
  const pairs = new Set<string>();
  transitions.forEach((tr, i) => {
    const key = tr.name.trim().toLowerCase();
    if (names.has(key)) issue(['transitions', i, 'name'], 'duplicate');
    names.add(key);
    if (tr.id) {
      if (ids.has(tr.id)) issue(['transitions', i, 'id'], 'duplicate');
      ids.add(tr.id);
    }
    if (!states.includes(tr.to)) issue(['transitions', i, 'to'], 'invalid_state');
    if (new Set(tr.from).size !== tr.from.length) issue(['transitions', i, 'from'], 'duplicate');
    tr.from.forEach((f) => {
      if (!states.includes(f)) issue(['transitions', i, 'from'], 'invalid_state');
      if (f === tr.to) issue(['transitions', i, 'from'], 'same_as_target');
      if (pairs.has(`${f}>${tr.to}`)) issue(['transitions', i, 'from'], 'duplicate_path');
      pairs.add(`${f}>${tr.to}`);
    });
    if (new Set(tr.roles).size !== tr.roles.length) issue(['transitions', i, 'roles'], 'duplicate');
    if (new Set(tr.fields).size !== tr.fields.length || tr.fields.some((f) => !BLUEPRINT_FIELDS[entity].includes(f))) issue(['transitions', i, 'fields'], 'invalid_field');
  });
}

/** 新建 / create */
export const blueprintCreateSchema = z
  .strictObject({
    name: requiredText(100),
    description: optionalText(500),
    entity: z.enum(RECORD_ENTITIES),
    isActive: z.boolean().default(false),
    transitions: z.array(transitionSchema).min(1).max(20),
  })
  .superRefine((v, ctx) => checkTransitions(v.entity, v.transitions, ctx));
/** 修改（对象不可改；改转换时需同时提交对象用于校验）/ update (entity fixed; send it with transitions for validation) */
export const blueprintUpdateSchema = z
  .strictObject({
    name: requiredText(100),
    description: optionalText(500),
    entity: z.enum(RECORD_ENTITIES),
    isActive: z.boolean(),
    transitions: z.array(transitionSchema).min(1).max(20),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.transitions && !v.entity) ctx.addIssue({ code: 'custom', path: ['entity'], message: 'required' });
    if (v.transitions && v.entity) checkTransitions(v.entity, v.transitions, ctx);
  });
/** 对象查询 / entity query */
export const blueprintEntitySchema = z.strictObject({ entity: z.enum(RECORD_ENTITIES) });
/** 记录的可用转换查询 / available transitions query */
export const blueprintRecordSchema = z.strictObject({ entity: z.enum(RECORD_ENTITIES), id: z.uuid() });
/** 执行转换 / run a transition */
export const transitionRunSchema = z.strictObject({
  entity: z.enum(RECORD_ENTITIES),
  id: z.uuid(),
  transitionId: z.uuid(),
  fields: z.record(z.string(), z.unknown()).default({}),
  note: z.string().trim().max(5000).optional(),
});

const select = {
  id: true,
  name: true,
  description: true,
  entity: true,
  isActive: true,
  transitions: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.BlueprintSelect;

/** 给新转换分配 ID / give new transitions ids */
const withIds = (list: z.infer<typeof transitionSchema>[]): Transition[] => list.map((tr) => ({ ...tr, id: tr.id ?? randomUUID(), fields: tr.fields ?? [], noteRequired: tr.noteRequired ?? false }));
/** 解析保存的转换（无法识别时为空）/ parse stored transitions (empty when unrecognised) */
const parseTransitions = (raw: unknown): Transition[] => {
  const r = z.array(transitionSchema).safeParse(raw);
  return r.success ? withIds(r.data) : [];
};

function conflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = String((err.meta as { target?: unknown } | undefined)?.target ?? '');
    if (target.includes('active')) throw new ApiError(409, 'CONFLICT', 'Another blueprint is active', { isActive: ['another_active'] });
    throw new ApiError(409, 'CONFLICT', 'Blueprint name already exists', { name: ['taken'] });
  }
  throw err;
}

/** 启用时检查同对象没有其他启用的蓝图 / when activating, no other blueprint of the entity may be active */
async function assertSingleActive(tx: Prisma.TransactionClient, org: string, entity: RecordEntity, exceptId: string | null) {
  const other = await tx.blueprint.findFirst({ where: { organizationId: org, entity, isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true } });
  if (other) throw new ApiError(409, 'CONFLICT', 'Another blueprint is active', { isActive: ['another_active'] });
}

/** 审计快照 / audit snapshot */
const auditView = (b: { name: string; entity: string; isActive: boolean; transitions: unknown }) => ({
  name: b.name,
  entity: b.entity,
  isActive: b.isActive,
  transitions: parseTransitions(b.transitions).map((tr) => `${tr.name}: ${tr.from.join('/')} → ${tr.to}`),
});

/**
 * 蓝图列表（需 blueprint.manage）。
 * List blueprints (blueprint.manage).
 */
export async function listBlueprints(ctx: AuthContext) {
  requirePermission(ctx, 'blueprint.manage');
  return { items: await prisma.blueprint.findMany({ where: { organizationId: ctx.organizationId }, select, orderBy: [{ entity: 'asc' }, { name: 'asc' }] }) };
}

/**
 * 对象当前启用的蓝图（所有用户可读，用于在表单中锁定受控字段）。
 * The active blueprint of an entity (everyone; used to lock the controlled field in forms).
 */
export async function blueprintStatus(ctx: AuthContext, entity: RecordEntity) {
  const bp = await activeBlueprint(ctx.organizationId, entity);
  return { active: bp ? { id: bp.id, name: bp.name } : null, field: BLUEPRINT_FIELD[entity] };
}

/**
 * 新建蓝图。
 * Create a blueprint.
 */
export async function createBlueprint(ctx: AuthContext, input: z.infer<typeof blueprintCreateSchema>) {
  requirePermission(ctx, 'blueprint.manage');
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`blueprint:${org}`}, 0))`;
      if ((await tx.blueprint.count({ where: { organizationId: org } })) >= MAX_BLUEPRINTS) throw new ApiError(409, 'CONFLICT', 'Too many blueprints', { name: ['limit_reached'] });
      if (input.isActive) await assertSingleActive(tx, org, input.entity, null);
      const b = await tx.blueprint.create({ data: { ...input, transitions: withIds(input.transitions) as unknown as Prisma.InputJsonValue, organizationId: org, createdById: ctx.userId }, select });
      await audit(tx, { ...by(ctx), action: 'blueprint.create', entityType: 'blueprint', entityId: b.id, changes: { after: auditView(b) } });
      return b;
    });
  } catch (err) {
    conflict(err);
  }
}

/**
 * 修改蓝图（对象不可改）。
 * Update a blueprint (the entity is fixed).
 */
export async function updateBlueprint(ctx: AuthContext, id: string, input: z.infer<typeof blueprintUpdateSchema>) {
  requirePermission(ctx, 'blueprint.manage');
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`blueprint:${org}`}, 0))`;
      const current = await tx.blueprint.findFirst({ where: { id, organizationId: org }, select });
      if (!current) throw notFound();
      if (input.entity && input.entity !== current.entity) throw new ApiError(400, 'VALIDATION_ERROR', 'The entity cannot change', { entity: ['immutable'] });
      if (input.isActive) await assertSingleActive(tx, org, asRecordEntity(current.entity), id);
      const data = { name: input.name, description: input.description, isActive: input.isActive, ...(input.transitions ? { transitions: withIds(input.transitions) as unknown as Prisma.InputJsonValue } : {}) };
      const b = await tx.blueprint.update({ where: { id }, data, select });
      const a = auditView(b);
      const before = auditView(current);
      const fields = Object.fromEntries((Object.keys(a) as (keyof typeof a)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(before[k])).map((k) => [k, [before[k], a[k]]]));
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'blueprint.update', entityType: 'blueprint', entityId: id, changes: { name: b.name, fields } });
      return b;
    });
  } catch (err) {
    conflict(err);
  }
}

/**
 * 删除蓝图（启用中的蓝图删除后受控字段恢复自由修改）。
 * Delete a blueprint (deleting an active one frees the controlled field).
 */
export async function deleteBlueprint(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'blueprint.manage');
  const b = await prisma.blueprint.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!b) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.blueprint.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'blueprint.delete', entityType: 'blueprint', entityId: id, changes: { before: auditView(b) } });
  });
}

/** 读取记录（可见范围内）/ load a visible record */
async function loadRecord(ctx: AuthContext, entity: RecordEntity, id: string) {
  const r = entity === WorkflowEntity.LEAD ? await getLead(ctx, id) : await getDeal(ctx, id);
  return r as unknown as Record<string, unknown> & { id: string; ownerId: string | null; convertedAt?: Date | null };
}

/**
 * 记录当前可执行的转换（当前状态为出发状态、角色允许、记录可编辑）。
 * Transitions the user can run on a record now (source state, allowed role, editable record).
 */
export async function availableTransitions(ctx: AuthContext, entity: RecordEntity, id: string) {
  const record = await loadRecord(ctx, entity, id);
  const bp = await activeBlueprint(ctx.organizationId, entity);
  const state = String(record[BLUEPRINT_FIELD[entity]]);
  if (!bp) return { blueprint: null, state, transitions: [] };
  let editable = true;
  try {
    assertCanUpdate(ctx, record);
  } catch {
    editable = false;
  }
  const transitions = editable && !record.convertedAt ? parseTransitions(bp.transitions).filter((tr) => tr.from.includes(state) && (tr.roles as UserRole[]).includes(ctx.role)) : [];
  return {
    blueprint: { id: bp.id, name: bp.name },
    state,
    transitions: transitions.map((tr) => ({ id: tr.id, name: tr.name, to: tr.to, fields: tr.fields, noteRequired: tr.noteRequired })),
  };
}

/** 必填字段是否有值 / whether a required field has a value */
function filled(field: string, v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  if (field === 'amount') return new Prisma.Decimal(String(v)).gt(0);
  return true;
}

/**
 * 执行转换。
 * Run a transition.
 */
export async function runTransition(ctx: AuthContext, input: z.infer<typeof transitionRunSchema>) {
  const { entity, id } = input;
  const field = BLUEPRINT_FIELD[entity];
  const bp = await activeBlueprint(ctx.organizationId, entity);
  if (!bp) throw new ApiError(409, 'CONFLICT', 'No active blueprint', { transitionId: ['no_blueprint'] });
  const tr = parseTransitions(bp.transitions).find((x) => x.id === input.transitionId);
  if (!tr) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown transition', { transitionId: ['not_found'] });
  const record = await loadRecord(ctx, entity, id);
  assertCanUpdate(ctx, record);
  const state = String(record[field]);
  if (record.convertedAt || !tr.from.includes(state)) throw new ApiError(409, 'CONFLICT', 'Transition not available', { transitionId: ['not_available'] });
  if (!(tr.roles as UserRole[]).includes(ctx.role)) throw new ApiError(403, 'FORBIDDEN', 'Role not allowed for this transition', { transitionId: ['role_not_allowed'] });
  // 只能提交转换要求的字段，按修改的规则校验 / only the transition's fields, validated like updates
  const extra = Object.keys(input.fields).filter((f) => !tr.fields.includes(f));
  if (extra.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Field not part of the transition', Object.fromEntries(extra.map((f) => [`fields.${f}`, ['not_allowed']])));
  const parsed = FIELD_SCHEMAS[entity].safeParse(input.fields);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid transition fields', Object.fromEntries(parsed.error.issues.map((i) => [`fields.${i.path.join('.')}`, [i.message]])));
  }
  const values = parsed.data as Record<string, unknown>;
  const missing = tr.fields.filter((f) => !filled(f, values[f] !== undefined ? values[f] : record[f]));
  if (missing.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Required fields are empty', Object.fromEntries(missing.map((f) => [`fields.${f}`, ['required']])));
  if (tr.noteRequired && !input.note) throw new ApiError(400, 'VALIDATION_ERROR', 'A note is required', { note: ['required'] });

  // 字段已按修改规则解析（日期已转换），直接传入，不再重复解析 / fields are already parsed (dates converted); pass them as is
  const updated =
    entity === WorkflowEntity.LEAD
      ? await updateLead(ctx, id, { ...(values as z.infer<typeof leadUpdateSchema>), status: tr.to as Exclude<LeadStatus, 'CONVERTED'> }, { expectedStatus: state as LeadStatus })
      : await updateDeal(ctx, id, { ...(values as z.infer<typeof dealUpdateSchema>), stage: tr.to as DealStage }, { expectedStage: state as DealStage });
  if (input.note) await createNote(ctx, { content: input.note, ...(entity === WorkflowEntity.LEAD ? { leadId: id } : { dealId: id }) });
  const auditEntity = entity === WorkflowEntity.LEAD ? 'lead' : 'deal';
  await audit(prisma, { ...by(ctx), action: `${auditEntity}.transition`, entityType: auditEntity, entityId: id, changes: { blueprint: bp.name, transition: tr.name, from: state, to: tr.to, ...(input.note ? { note: true } : {}) } });
  return updated;
}
