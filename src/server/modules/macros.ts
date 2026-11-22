/**
 * 宏（对标 Zoho Macros）：把一组常用操作保存下来，在线索或商机的列表（选中多条）或详情中一键执行。
 * - 动作（1–5 个）：修改字段（线索状态、来源；商机阶段）、指派负责人、添加标签、移除标签、新建任务（指派给负责人或指定用户）。
 * - 范围：个人宏只有创建人可见、可改；共享宏所有人可见，维护需 macro.manage（管理员、经理）。每组织最多 100 个，
 *   每人最多 20 个个人宏；名称在组织内不重复。
 * - 执行：以执行人的身份逐条调用已有的修改、标签、跟进服务，因此记录可见范围、编辑权限、验证规则、工作流、阶段历史、
 *   审计与通知都照常生效；单次最多 100 条。指派负责人或把任务指派给指定用户需要 owner.assign。
 *   每条记录先改字段与负责人（一次修改），再改标签，最后建任务；某一步失败时该记录后续动作不再执行，
 *   已完成的步骤保留（不跨步骤回滚），失败原因逐条返回。
 * - 维护与执行都写审计（执行记录成功、失败条数）。
 * Macros (cf. Zoho Macros): save a set of common actions and run them in one click on chosen leads or deals (list
 * selection or detail). Actions (1–5): update a field (lead status or source, deal stage), assign an owner, add or
 * remove a tag, create a task (for the owner or a given user). Personal macros are visible to and editable by their
 * creator only; shared macros are visible to everyone and maintained with macro.manage (admins, managers). At most 100
 * per organization and 20 personal macros per user; names are unique per organization. Runs call the existing update,
 * tag and activity services as the runner, so visibility, edit rights, validation rules, workflows, stage history,
 * audits and notifications all apply; at most 100 records per run. Assigning owners or tasks to a given user needs
 * owner.assign. Per record: fields and owner (one update), then tags, then tasks; a failing step stops that record's
 * remaining actions and earlier steps stay (no cross-step rollback); failures are returned per record. Maintenance and
 * runs are audited.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { MacroScope, WorkflowEntity } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, can, requirePermission } from '../permissions';
import { optionalText, requiredText } from '../validation';
import { activityCreateSchema, createActivity } from './activities';
import { runBulk, type BulkResult } from './bulk';
import { dealUpdateSchema, getDeal, updateDeal } from './deals';
import { getLead, leadUpdateSchema, updateLead } from './leads';
import { changeRecordTags } from './tags';
import { UPDATE_FIELDS } from './workflows';

/** 每组织最多宏数 / max macros per organization */
export const MAX_MACROS = 100;
/** 每人最多个人宏数 / max personal macros per user */
export const MAX_PERSONAL_MACROS = 20;
/** 单次最多执行的记录数 / max records per run */
export const MACRO_RUN_MAX = 100;

/** 宏的动作 / macro action */
export const macroActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('UPDATE_FIELD'), field: z.string().max(30), value: z.string().max(30) }),
  z.strictObject({ type: z.literal('ASSIGN_OWNER'), userId: z.uuid() }),
  z.strictObject({ type: z.literal('ADD_TAG'), tagId: z.uuid() }),
  z.strictObject({ type: z.literal('REMOVE_TAG'), tagId: z.uuid() }),
  z.strictObject({ type: z.literal('CREATE_TASK'), subject: requiredText(200), dueInDays: z.number().int().min(0).max(365), assignTo: z.union([z.literal('OWNER'), z.uuid()]) }),
]);
export type MacroAction = z.infer<typeof macroActionSchema>;

/** 按对象校验动作：字段与取值、同一字段只改一次、只指派一次、同一标签不能既加又减 / validate actions per entity */
function checkActions(entity: WorkflowEntity, actions: MacroAction[], ctx: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const fields = new Set<string>();
  const tags = new Map<string, string>();
  let owners = 0;
  actions.forEach((a, i) => {
    if (a.type === 'UPDATE_FIELD') {
      const values = UPDATE_FIELDS[entity][a.field];
      if (!values) issue(['actions', i, 'field'], 'invalid_field');
      else if (!values.includes(a.value)) issue(['actions', i, 'value'], 'invalid_value');
      if (fields.has(a.field)) issue(['actions', i, 'field'], 'duplicate');
      fields.add(a.field);
    }
    if (a.type === 'ASSIGN_OWNER' && ++owners > 1) issue(['actions', i, 'type'], 'duplicate');
    if (a.type === 'ADD_TAG' || a.type === 'REMOVE_TAG') {
      if (tags.has(a.tagId)) issue(['actions', i, 'tagId'], 'duplicate');
      tags.set(a.tagId, a.type);
    }
  });
}

/** 新建 / create */
export const macroCreateSchema = z
  .strictObject({
    name: requiredText(100),
    description: optionalText(500),
    entity: z.enum(WorkflowEntity),
    scope: z.enum(MacroScope).default(MacroScope.PERSONAL),
    actions: z.array(macroActionSchema).min(1).max(5),
  })
  .superRefine((v, ctx) => checkActions(v.entity, v.actions, ctx));
/** 修改（对象不可改；改动作时需同时提交对象用于校验）/ update (entity fixed; send it with actions for validation) */
export const macroUpdateSchema = z
  .strictObject({
    name: requiredText(100),
    description: optionalText(500),
    entity: z.enum(WorkflowEntity),
    scope: z.enum(MacroScope),
    actions: z.array(macroActionSchema).min(1).max(5),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.actions && !v.entity) ctx.addIssue({ code: 'custom', path: ['entity'], message: 'required' });
    if (v.actions && v.entity) checkActions(v.entity, v.actions, ctx);
  });
/** 列表 / list */
export const macroListSchema = z.strictObject({ entity: z.enum(WorkflowEntity).optional() });
/** 执行 / run */
export const macroRunSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(MACRO_RUN_MAX)
    .transform((v) => [...new Set(v)]),
});

const select = {
  id: true,
  name: true,
  description: true,
  entity: true,
  scope: true,
  actions: true,
  createdById: true,
  runCount: true,
  lastRunAt: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.MacroSelect;
type Row = Prisma.MacroGetPayload<{ select: typeof select }>;

/** 当前用户可见的宏：共享的与自己的个人宏 / macros visible to the user: shared ones and their own personal ones */
const visibleMacros = (ctx: AuthContext): Prisma.MacroWhereInput => ({
  organizationId: ctx.organizationId,
  OR: [{ scope: MacroScope.SHARED }, { scope: MacroScope.PERSONAL, createdById: ctx.userId }],
});
/** 能否维护：共享宏需 macro.manage，个人宏只有创建人 / may maintain: shared needs macro.manage, personal only the creator */
const canEdit = (ctx: AuthContext, m: { scope: MacroScope; createdById: string }) => (m.scope === MacroScope.SHARED ? can(ctx, 'macro.manage') : m.createdById === ctx.userId);
const shape = (ctx: AuthContext, m: Row) => ({ ...m, editable: canEdit(ctx, m) });

/**
 * 执行或保存前的检查：指派需 owner.assign；引用的用户须为本组织启用用户、标签须属于本组织。
 * Checks before saving or running: assignments need owner.assign; users must be active members, tags must exist.
 */
async function checkRefs(ctx: AuthContext, actions: MacroAction[]): Promise<void> {
  const users = new Set<string>();
  const tags = new Set<string>();
  for (const a of actions) {
    if (a.type === 'ASSIGN_OWNER') users.add(a.userId);
    if (a.type === 'CREATE_TASK' && a.assignTo !== 'OWNER') users.add(a.assignTo);
    if (a.type === 'ADD_TAG' || a.type === 'REMOVE_TAG') tags.add(a.tagId);
  }
  if ([...users].some((u) => u !== ctx.userId) && !can(ctx, 'owner.assign')) {
    throw new ApiError(403, 'FORBIDDEN', 'Assigning to others needs owner.assign', { actions: ['owner.assign required'] });
  }
  const [u, t] = await Promise.all([
    prisma.user.count({ where: { organizationId: ctx.organizationId, isActive: true, id: { in: [...users] } } }),
    prisma.tag.count({ where: { organizationId: ctx.organizationId, id: { in: [...tags] } } }),
  ]);
  const codes = [...(u !== users.size ? ['user_not_found'] : []), ...(t !== tags.size ? ['tag_not_found'] : [])];
  if (codes.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid macro actions', { actions: codes });
}

function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Macro name already exists', { name: ['taken'] });
  throw err;
}

/** 审计用快照 / audit snapshot */
const auditView = (m: { name: string; entity: WorkflowEntity; scope: MacroScope; actions: unknown }) => ({ name: m.name, entity: m.entity, scope: m.scope, actions: m.actions });

/**
 * 宏列表（共享的与自己的个人宏，按名称）。
 * Macros visible to the user (shared and own personal), by name.
 */
export async function listMacros(ctx: AuthContext, query: z.infer<typeof macroListSchema>) {
  const rows = await prisma.macro.findMany({ where: { ...visibleMacros(ctx), entity: query.entity }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  return { items: rows.map((m) => shape(ctx, m)) };
}

/**
 * 新建宏：个人宏需 record.update.own，共享宏需 macro.manage。
 * Create a macro: personal needs record.update.own, shared needs macro.manage.
 */
export async function createMacro(ctx: AuthContext, input: z.infer<typeof macroCreateSchema>) {
  requirePermission(ctx, 'record.update.own');
  if (input.scope === MacroScope.SHARED) requirePermission(ctx, 'macro.manage');
  await checkRefs(ctx, input.actions);
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`macro:${org}`}, 0))`;
      if ((await tx.macro.count({ where: { organizationId: org } })) >= MAX_MACROS) throw new ApiError(409, 'CONFLICT', 'Too many macros', { name: ['limit_reached'] });
      if (input.scope === MacroScope.PERSONAL && (await tx.macro.count({ where: { organizationId: org, scope: MacroScope.PERSONAL, createdById: ctx.userId } })) >= MAX_PERSONAL_MACROS) {
        throw new ApiError(409, 'CONFLICT', 'Too many personal macros', { name: ['personal_limit_reached'] });
      }
      const m = await tx.macro.create({ data: { ...input, actions: input.actions as Prisma.InputJsonValue, organizationId: org, createdById: ctx.userId }, select });
      await audit(tx, { ...by(ctx), action: 'macro.create', entityType: 'macro', entityId: m.id, changes: { after: auditView(m) } });
      return shape(ctx, m);
    });
  } catch (err) {
    nameTaken(err);
  }
}

/** 读取可维护的宏（不可见 404，不可维护 403）/ load an editable macro (404 if invisible, 403 if read-only) */
async function editableMacro(ctx: AuthContext, id: string) {
  const m = await prisma.macro.findFirst({ where: { id, ...visibleMacros(ctx) }, select });
  if (!m) throw notFound();
  if (!canEdit(ctx, m)) throw new ApiError(403, 'FORBIDDEN', 'Cannot edit this macro');
  return m;
}

/**
 * 修改宏（对象不可改；改为共享需 macro.manage）。
 * Update a macro (the entity is fixed; making it shared needs macro.manage).
 */
export async function updateMacro(ctx: AuthContext, id: string, input: z.infer<typeof macroUpdateSchema>) {
  const current = await editableMacro(ctx, id);
  if (input.entity && input.entity !== current.entity) throw new ApiError(400, 'VALIDATION_ERROR', 'The entity cannot change', { entity: ['immutable'] });
  if (input.scope === MacroScope.SHARED) requirePermission(ctx, 'macro.manage');
  if (input.scope === MacroScope.PERSONAL && current.scope === MacroScope.SHARED && current.createdById !== ctx.userId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only the creator can make it personal', { scope: ['not_creator'] });
  }
  if (input.actions) await checkRefs(ctx, input.actions);
  // 对象只用于校验动作，不写入 / the entity only validates actions and is not written
  const data = { name: input.name, description: input.description, scope: input.scope, actions: input.actions };
  try {
    return await prisma.$transaction(async (tx) => {
      const m = await tx.macro.update({ where: { id }, data: { ...data, ...(data.actions ? { actions: data.actions as Prisma.InputJsonValue } : {}) }, select });
      const a = auditView(m);
      const b = auditView(current);
      const fields = Object.fromEntries((Object.keys(a) as (keyof typeof a)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => [k, [b[k], a[k]]]));
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'macro.update', entityType: 'macro', entityId: id, changes: { name: m.name, fields } });
      return shape(ctx, m);
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除宏。
 * Delete a macro.
 */
export async function deleteMacro(ctx: AuthContext, id: string): Promise<void> {
  const m = await editableMacro(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.macro.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'macro.delete', entityType: 'macro', entityId: id, changes: { before: auditView(m) } });
  });
}

/**
 * 对一条记录执行宏的动作（以执行人的身份调用已有服务）。
 * Run a macro's actions on one record (calling the existing services as the runner).
 */
async function runOne(ctx: AuthContext, entity: WorkflowEntity, actions: MacroAction[], id: string) {
  const isLead = entity === WorkflowEntity.LEAD;
  // 1. 字段与负责人：一次修改 / fields and owner in one update
  const body: Record<string, string> = {};
  for (const a of actions) {
    if (a.type === 'UPDATE_FIELD') body[a.field] = a.value;
    if (a.type === 'ASSIGN_OWNER') body.ownerId = a.userId;
  }
  let ownerId: string | null;
  if (Object.keys(body).length) {
    ownerId = (isLead ? await updateLead(ctx, id, leadUpdateSchema.parse(body)) : await updateDeal(ctx, id, dealUpdateSchema.parse(body))).ownerId;
  } else {
    const record = isLead ? await getLead(ctx, id) : await getDeal(ctx, id);
    assertCanUpdate(ctx, record);
    ownerId = record.ownerId;
  }
  // 2. 标签 / tags
  const add = actions.flatMap((a) => (a.type === 'ADD_TAG' ? [a.tagId] : []));
  const remove = actions.flatMap((a) => (a.type === 'REMOVE_TAG' ? [a.tagId] : []));
  if (add.length || remove.length) await changeRecordTags(ctx, isLead ? 'lead' : 'deal', id, (current) => [...current.filter((t) => !remove.includes(t)), ...add]);
  // 3. 任务 / tasks
  for (const a of actions) {
    if (a.type !== 'CREATE_TASK') continue;
    const owner = a.assignTo === 'OWNER' ? ownerId : a.assignTo;
    await createActivity(
      ctx,
      activityCreateSchema.parse({
        type: 'TASK',
        subject: a.subject,
        dueAt: new Date(Date.now() + a.dueInDays * 86_400_000).toISOString(),
        ...(isLead ? { leadId: id } : { dealId: id }),
        ...(owner ? { ownerId: owner } : {}),
      }),
    );
  }
}

/**
 * 执行宏：逐条处理选中的记录，返回成功与失败（含原因）。
 * Run a macro on the chosen records one by one, returning successes and failures with reasons.
 */
export async function runMacro(ctx: AuthContext, id: string, input: z.infer<typeof macroRunSchema>): Promise<BulkResult> {
  requirePermission(ctx, 'record.update.own');
  const m = await prisma.macro.findFirst({ where: { id, ...visibleMacros(ctx) }, select });
  if (!m) throw notFound();
  const actions = z.array(macroActionSchema).parse(m.actions);
  await checkRefs(ctx, actions);
  const result = await runBulk(input.ids, (recordId) => runOne(ctx, m.entity, actions, recordId));
  await prisma.$transaction(async (tx) => {
    await tx.macro.update({ where: { id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
    await audit(tx, {
      ...by(ctx),
      action: 'macro.run',
      entityType: 'macro',
      entityId: id,
      changes: { name: m.name, entity: m.entity, succeeded: result.succeeded.length, failed: result.failed.length },
    });
  });
  return result;
}
