/**
 * 销售节奏（对标 Zoho Cadences）：一组按天数排列的跟进步骤（电话、会议、拜访、任务），把线索或商机加入后，
 * 每一步到期时自动为记录负责人创建跟进（没有负责人时给加入人）。
 * - 节奏：1–10 个步骤（第 0–365 天，按天数排序）、退出状态（线索状态或商机阶段，最多 10 个）、启停；每组织最多 50 个。
 *   维护需 cadence.manage（管理员、经理）并写审计；所有用户可读取（用于加入）。
 * - 加入：需能编辑记录；节奏须启用；已转化线索、已处于退出状态的记录、已在该节奏中进行的记录不能加入；单次最多 100 条。
 *   第 0 天的步骤在加入时立即创建。
 * - 执行：定时任务（与定时工作流同一个定时器，每 15 分钟）处理到期的参与；错过的步骤补建；全部完成后为“已完成”；
 *   记录进入退出状态或线索已转化时为“已退出”（每次运行都会检查）；停用的节奏暂停处理。多个进程同时运行时每个参与只处理一次。
 * - 停止：能编辑记录的用户可停止进行中的参与。修改步骤时，进行中参与的下一步时间按新步骤重算。
 * Cadences (cf. Zoho Cadences): day-ordered follow-up steps (call, meeting, visit, task); enrolled leads or deals get
 * an activity for their owner (or the enroller without an owner) as each step falls due. A cadence has 1–10 steps
 * (day 0–365, ordered), exit states (lead statuses or deal stages, at most 10) and an active flag; at most 50 per
 * organization; maintenance needs cadence.manage (admins, managers) and is audited; everyone can read them. Enrolling
 * needs edit rights on the record and an active cadence; converted leads, records already in an exit state and
 * records already active in the cadence are refused; at most 100 per request; day-0 steps are created right away.
 * The scheduled job (the workflow timer, every 15 minutes) processes due enrollments, catches up missed steps, marks
 * finished ones completed and exits records that reached an exit state or were converted; inactive cadences pause.
 * Concurrent runs process each enrollment once. Users who can edit the record may stop an active enrollment; editing
 * steps recomputes the next due time of active enrollments.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { ActivityType, CadenceStatus, DealStage, LeadStatus, WorkflowEntity } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, requirePermission } from '../permissions';
import { optionalText, requiredText } from '../validation';
import { runBulk, type BulkResult } from './bulk';
import { getDeal } from './deals';
import { getLead } from './leads';

/** 每组织最多节奏数 / max cadences per organization */
export const MAX_CADENCES = 50;
/** 单次最多加入的记录数 / max records per enroll request */
export const ENROLL_MAX = 100;
/** 定时任务每批处理的参与数 / enrollments per sweep batch */
const SWEEP_BATCH = 500;
const DAY = 86_400_000;

/** 各对象可作为退出条件的状态 / exit states per entity */
export const CADENCE_EXIT_STATES: Record<WorkflowEntity, readonly string[]> = {
  LEAD: [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUALIFIED, LeadStatus.UNQUALIFIED],
  DEAL: Object.values(DealStage),
};
/** 记录的状态字段 / the record's state field */
const STATE_FIELD = { LEAD: 'status', DEAL: 'stage' } as const;

/** 步骤 / step */
export const stepSchema = z.strictObject({
  day: z.number().int().min(0).max(365),
  type: z.enum(ActivityType),
  subject: requiredText(200),
});
export type Step = z.infer<typeof stepSchema>;

/** 校验：步骤按天数排序、退出状态属于对象且不重复 / steps ordered by day; exit states valid and unique */
function checkCadence(entity: WorkflowEntity, steps: Step[] | undefined, exitStates: string[] | undefined, ctx: z.RefinementCtx) {
  steps?.forEach((s, i) => {
    if (i > 0 && s.day < steps[i - 1]!.day) ctx.addIssue({ code: 'custom', path: ['steps', i, 'day'], message: 'not_ordered' });
  });
  if (exitStates && (new Set(exitStates).size !== exitStates.length || exitStates.some((s) => !CADENCE_EXIT_STATES[entity].includes(s)))) {
    ctx.addIssue({ code: 'custom', path: ['exitStates'], message: 'invalid_state' });
  }
}

/** 新建 / create */
export const cadenceCreateSchema = z
  .strictObject({
    name: requiredText(100),
    description: optionalText(500),
    entity: z.enum(WorkflowEntity),
    isActive: z.boolean().default(true),
    steps: z.array(stepSchema).min(1).max(10),
    exitStates: z.array(z.string().max(30)).max(10).default([]),
  })
  .superRefine((v, ctx) => checkCadence(v.entity, v.steps, v.exitStates, ctx));
/** 修改（对象不可改；改步骤或退出状态时需同时提交对象）/ update (entity fixed; send it with steps or exit states) */
export const cadenceUpdateSchema = z
  .strictObject({
    name: requiredText(100),
    description: optionalText(500),
    entity: z.enum(WorkflowEntity),
    isActive: z.boolean(),
    steps: z.array(stepSchema).min(1).max(10),
    exitStates: z.array(z.string().max(30)).max(10),
  })
  .partial()
  .superRefine((v, ctx) => {
    if ((v.steps || v.exitStates) && !v.entity) ctx.addIssue({ code: 'custom', path: ['entity'], message: 'required' });
    if (v.entity) checkCadence(v.entity, v.steps, v.exitStates, ctx);
  });
/** 列表 / list */
export const cadenceListSchema = z.strictObject({ entity: z.enum(WorkflowEntity).optional() });
/** 加入 / enroll */
export const enrollSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(ENROLL_MAX)
    .transform((v) => [...new Set(v)]),
});
/** 记录的参与 / a record's enrollments */
export const enrollmentListSchema = z.strictObject({ entity: z.enum(WorkflowEntity), id: z.uuid() });

const select = {
  id: true,
  name: true,
  description: true,
  entity: true,
  isActive: true,
  steps: true,
  exitStates: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.CadenceSelect;

/** 解析保存的步骤与退出状态（无法识别时为空）/ parse stored steps and exit states (empty when unrecognised) */
const stepsOf = (raw: unknown): Step[] => {
  const r = z.array(stepSchema).safeParse(raw);
  return r.success ? r.data : [];
};
const exitStatesOf = (raw: unknown): string[] => {
  const r = z.array(z.string()).safeParse(raw);
  return r.success ? r.data : [];
};
/** 步骤到期时间 / when a step is due */
const dueAt = (enrolledAt: Date, step: Step) => new Date(enrolledAt.getTime() + step.day * DAY);

function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Cadence name already exists', { name: ['taken'] });
  throw err;
}

/** 审计快照 / audit snapshot */
const auditView = (c: { name: string; entity: WorkflowEntity; isActive: boolean; steps: unknown; exitStates: unknown }) => ({
  name: c.name,
  entity: c.entity,
  isActive: c.isActive,
  steps: stepsOf(c.steps).map((s) => `D${s.day} ${s.type} ${s.subject}`),
  exitStates: exitStatesOf(c.exitStates),
});

/**
 * 节奏列表（含各状态的参与数）。
 * Cadences with enrollment counts per status.
 */
export async function listCadences(ctx: AuthContext, query: z.infer<typeof cadenceListSchema>) {
  const org = ctx.organizationId;
  const [rows, counts] = await Promise.all([
    prisma.cadence.findMany({ where: { organizationId: org, entity: query.entity }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    prisma.cadenceEnrollment.groupBy({ by: ['cadenceId', 'status'], where: { organizationId: org }, _count: { _all: true } }),
  ]);
  const count = (id: string, status: CadenceStatus) => counts.find((c) => c.cadenceId === id && c.status === status)?._count._all ?? 0;
  return {
    items: rows.map((c) => ({
      ...c,
      counts: { active: count(c.id, CadenceStatus.ACTIVE), completed: count(c.id, CadenceStatus.COMPLETED), exited: count(c.id, CadenceStatus.EXITED), stopped: count(c.id, CadenceStatus.STOPPED) },
    })),
  };
}

/**
 * 新建节奏。
 * Create a cadence.
 */
export async function createCadence(ctx: AuthContext, input: z.infer<typeof cadenceCreateSchema>) {
  requirePermission(ctx, 'cadence.manage');
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`cadence:${org}`}, 0))`;
      if ((await tx.cadence.count({ where: { organizationId: org } })) >= MAX_CADENCES) throw new ApiError(409, 'CONFLICT', 'Too many cadences', { name: ['limit_reached'] });
      const c = await tx.cadence.create({ data: { ...input, organizationId: org, createdById: ctx.userId }, select });
      await audit(tx, { ...by(ctx), action: 'cadence.create', entityType: 'cadence', entityId: c.id, changes: { after: auditView(c) } });
      return c;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 修改节奏（对象不可改）；改步骤时重算进行中参与的下一步时间，步骤已全部执行的参与变为已完成。
 * Update a cadence (entity fixed); new steps recompute active enrollments' next due time and complete finished ones.
 */
export async function updateCadence(ctx: AuthContext, id: string, input: z.infer<typeof cadenceUpdateSchema>) {
  requirePermission(ctx, 'cadence.manage');
  const org = ctx.organizationId;
  const current = await prisma.cadence.findFirst({ where: { id, organizationId: org }, select });
  if (!current) throw notFound();
  if (input.entity && input.entity !== current.entity) throw new ApiError(400, 'VALIDATION_ERROR', 'The entity cannot change', { entity: ['immutable'] });
  // 对象只用于校验，不写入 / the entity only validates and is not written
  const data = { name: input.name, description: input.description, isActive: input.isActive, steps: input.steps, exitStates: input.exitStates };
  try {
    return await prisma.$transaction(async (tx) => {
      const c = await tx.cadence.update({ where: { id }, data, select });
      if (input.steps) {
        const steps = input.steps;
        const active = await tx.cadenceEnrollment.findMany({ where: { cadenceId: id, status: CadenceStatus.ACTIVE }, select: { id: true, currentStep: true, enrolledAt: true } });
        for (const e of active) {
          const next = steps[e.currentStep];
          await tx.cadenceEnrollment.update({
            where: { id: e.id },
            data: next ? { nextDueAt: dueAt(e.enrolledAt, next) } : { status: CadenceStatus.COMPLETED, nextDueAt: null, endedAt: new Date(), endReason: 'completed' },
          });
        }
      }
      const a = auditView(c);
      const b = auditView(current);
      const fields = Object.fromEntries((Object.keys(a) as (keyof typeof a)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => [k, [b[k], a[k]]]));
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'cadence.update', entityType: 'cadence', entityId: id, changes: { name: c.name, fields } });
      return c;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除节奏（参与记录随之删除，已创建的跟进保留）。
 * Delete a cadence (its enrollments go too; created activities stay).
 */
export async function deleteCadence(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'cadence.manage');
  const c = await prisma.cadence.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!c) throw notFound();
  await prisma.$transaction(async (tx) => {
    const enrollments = await tx.cadenceEnrollment.count({ where: { cadenceId: id } });
    await tx.cadence.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'cadence.delete', entityType: 'cadence', entityId: id, changes: { before: auditView(c), enrollments } });
  });
}

/** 参与处理时需要的记录信息 / record data needed to process an enrollment */
interface TargetRecord {
  id: string;
  name: string;
  ownerId: string | null;
  state: string;
  converted: boolean;
}
async function loadTarget(tx: Prisma.TransactionClient, entity: WorkflowEntity, id: string): Promise<TargetRecord | null> {
  if (entity === WorkflowEntity.LEAD) {
    const l = await tx.lead.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, status: true, convertedAt: true } });
    return l && { id: l.id, name: l.name, ownerId: l.ownerId, state: l.status, converted: !!l.convertedAt || l.status === LeadStatus.CONVERTED };
  }
  const d = await tx.deal.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, stage: true } });
  return d && { id: d.id, name: d.name, ownerId: d.ownerId, state: d.stage, converted: false };
}

/** 本组织启用的用户 / an active member of the organization */
async function activeUser(tx: Prisma.TransactionClient, org: string, id: string | null) {
  if (!id) return null;
  return (await tx.user.findFirst({ where: { id, organizationId: org, isActive: true }, select: { id: true } }))?.id ?? null;
}

/**
 * 处理一个参与：检查退出条件，创建全部到期步骤的跟进，更新进度（在调用方的事务内，参与已锁定）。
 * Process one enrollment: check exit conditions, create activities for every due step and update progress (inside
 * the caller's transaction with the enrollment locked).
 * @returns 创建的跟进数 / activities created
 */
async function processEnrollment(
  tx: Prisma.TransactionClient,
  e: { id: string; organizationId: string; currentStep: number; enrolledAt: Date; enrolledById: string; leadId: string | null; dealId: string | null },
  cadence: { id: string; name: string; entity: WorkflowEntity; steps: unknown; exitStates: unknown },
  now: Date,
  actorId: string | null,
): Promise<number> {
  const recordId = (e.leadId ?? e.dealId)!;
  const record = await loadTarget(tx, cadence.entity, recordId);
  const end = (reason: string, status: CadenceStatus) => tx.cadenceEnrollment.update({ where: { id: e.id }, data: { status, nextDueAt: null, endedAt: now, endReason: reason } });
  if (!record) return 0; // 记录删除时参与随之级联删除 / enrollments cascade with deleted records
  if (record.converted) return (await end('converted', CadenceStatus.EXITED), 0);
  if (exitStatesOf(cadence.exitStates).includes(record.state)) return (await end(`state:${record.state}`, CadenceStatus.EXITED), 0);
  const steps = stepsOf(cadence.steps);
  let step = e.currentStep;
  let created = 0;
  const owner = (await activeUser(tx, e.organizationId, record.ownerId)) ?? (await activeUser(tx, e.organizationId, e.enrolledById));
  while (step < steps.length && dueAt(e.enrolledAt, steps[step]!) <= now) {
    const s = steps[step]!;
    const activity = await tx.activity.create({
      data: {
        organizationId: e.organizationId,
        type: s.type,
        subject: s.subject,
        dueAt: new Date(Math.max(now.getTime(), dueAt(e.enrolledAt, s).getTime())),
        ownerId: owner,
        ...(cadence.entity === WorkflowEntity.LEAD ? { leadId: recordId } : { dealId: recordId }),
      },
    });
    await audit(tx, {
      organizationId: e.organizationId,
      actorId,
      action: 'activity.create',
      entityType: 'activity',
      entityId: activity.id,
      changes: { after: { type: s.type, subject: s.subject, ownerId: owner }, cadence: cadence.name, step: step + 1, of: steps.length },
    });
    step += 1;
    created += 1;
  }
  const next = steps[step];
  await tx.cadenceEnrollment.update({
    where: { id: e.id },
    data: next ? { currentStep: step, nextDueAt: dueAt(e.enrolledAt, next) } : { currentStep: step, status: CadenceStatus.COMPLETED, nextDueAt: null, endedAt: now, endReason: 'completed' },
  });
  return created;
}

/** 读取记录（可见且可编辑）/ load a visible, editable record */
async function editableRecord(ctx: AuthContext, entity: WorkflowEntity, id: string) {
  const r = entity === WorkflowEntity.LEAD ? await getLead(ctx, id) : await getDeal(ctx, id);
  assertCanUpdate(ctx, r);
  return r;
}

/**
 * 把记录加入节奏（逐条，返回成功与失败）。
 * Enroll records one by one, returning successes and failures.
 */
export async function enroll(ctx: AuthContext, cadenceId: string, input: z.infer<typeof enrollSchema>): Promise<BulkResult> {
  requirePermission(ctx, 'record.update.own');
  const cadence = await prisma.cadence.findFirst({ where: { id: cadenceId, organizationId: ctx.organizationId }, select: { id: true, name: true, entity: true, steps: true, exitStates: true, isActive: true } });
  if (!cadence) throw notFound();
  if (!cadence.isActive) throw new ApiError(409, 'CONFLICT', 'The cadence is inactive', { cadenceId: ['inactive'] });
  const field = cadence.entity === WorkflowEntity.LEAD ? 'leadId' : 'dealId';
  const result = await runBulk(input.ids, async (id) => {
    const record = await editableRecord(ctx, cadence.entity, id);
    const state = String((record as unknown as Record<string, unknown>)[STATE_FIELD[cadence.entity]]);
    if ('convertedAt' in record && record.convertedAt) throw new ApiError(409, 'CONFLICT', 'Converted leads cannot be enrolled', { [field]: ['converted'] });
    if (exitStatesOf(cadence.exitStates).includes(state)) throw new ApiError(409, 'CONFLICT', 'The record is in an exit state', { [field]: ['exit_state'] });
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const e = await tx.cadenceEnrollment.create({
          data: { organizationId: ctx.organizationId, cadenceId, [field]: id, enrolledById: ctx.userId, enrolledAt: now, nextDueAt: now },
        });
        await audit(tx, { ...by(ctx), action: 'cadence.enroll', entityType: 'cadence', entityId: cadenceId, changes: { name: cadence.name, record: record.name, recordId: id } });
        await processEnrollment(tx, e, cadence, now, ctx.userId);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Already enrolled', { [field]: ['already_enrolled'] });
      throw err;
    }
  });
  return result;
}

/**
 * 记录的参与列表（最新在前）。
 * A record's enrollments, newest first.
 */
export async function listEnrollments(ctx: AuthContext, query: z.infer<typeof enrollmentListSchema>) {
  if (query.entity === WorkflowEntity.LEAD) await getLead(ctx, query.id);
  else await getDeal(ctx, query.id);
  const rows = await prisma.cadenceEnrollment.findMany({
    where: { organizationId: ctx.organizationId, ...(query.entity === WorkflowEntity.LEAD ? { leadId: query.id } : { dealId: query.id }) },
    select: { id: true, status: true, currentStep: true, nextDueAt: true, enrolledAt: true, endedAt: true, endReason: true, cadence: { select: { id: true, name: true, steps: true } }, enrolledBy: { select: { id: true, name: true } } },
    orderBy: [{ enrolledAt: 'desc' }, { id: 'asc' }],
  });
  return { items: rows.map(({ cadence, ...e }) => ({ ...e, cadence: { id: cadence.id, name: cadence.name, stepCount: stepsOf(cadence.steps).length } })) };
}

/**
 * 停止进行中的参与（需能编辑记录）。
 * Stop an active enrollment (needs edit rights on the record).
 */
export async function stopEnrollment(ctx: AuthContext, id: string) {
  const e = await prisma.cadenceEnrollment.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { cadence: { select: { name: true, entity: true } } } });
  if (!e) throw notFound();
  const record = await editableRecord(ctx, e.cadence.entity, (e.leadId ?? e.dealId)!);
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.cadenceEnrollment.updateMany({ where: { id, status: CadenceStatus.ACTIVE }, data: { status: CadenceStatus.STOPPED, nextDueAt: null, endedAt: new Date(), endReason: 'stopped' } });
    if (!count) throw new ApiError(409, 'CONFLICT', 'The enrollment is not active', { id: ['not_active'] });
    await audit(tx, { ...by(ctx), action: 'cadence.stop', entityType: 'cadence', entityId: e.cadenceId, changes: { name: e.cadence.name, record: record.name, recordId: record.id } });
    return { stopped: true };
  });
}

/**
 * 定时任务：先让进入退出状态或已转化的记录退出，再处理到期的参与（每个参与单独加锁，多个进程同时运行时只处理一次）。
 * Scheduled job: exit records in exit states or converted, then process due enrollments (each locked on its own, so
 * concurrent runs process it once).
 */
export async function sweepCadences(opts: { organizationId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const cadences = await prisma.cadence.findMany({ where: { organizationId: opts.organizationId, isActive: true }, select: { id: true, name: true, entity: true, steps: true, exitStates: true, organizationId: true } });
  const result = { cadences: cadences.length, exited: 0, processed: 0, activities: 0, failures: [] as { enrollmentId: string; error: string }[] };
  for (const c of cadences) {
    // 退出：线索已转化或记录处于退出状态 / exits: converted leads or records in an exit state
    const states = exitStatesOf(c.exitStates);
    const record: Prisma.CadenceEnrollmentWhereInput =
      c.entity === WorkflowEntity.LEAD
        ? { lead: { OR: [{ convertedAt: { not: null } }, { status: { in: [...states, LeadStatus.CONVERTED] as LeadStatus[] } }] } }
        : { deal: { stage: { in: states as DealStage[] } } };
    const ending = await prisma.cadenceEnrollment.findMany({ where: { cadenceId: c.id, status: CadenceStatus.ACTIVE, ...record }, select: { id: true } });
    for (const { id } of ending) {
      result.exited += await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cadence_enrollments WHERE id = ${id}::uuid AND status = 'ACTIVE' FOR UPDATE SKIP LOCKED`;
        if (!locked) return 0;
        const e = await tx.cadenceEnrollment.findUniqueOrThrow({ where: { id } });
        const r = await loadTarget(tx, c.entity, (e.leadId ?? e.dealId)!);
        if (!r) return 0;
        await tx.cadenceEnrollment.update({ where: { id }, data: { status: CadenceStatus.EXITED, nextDueAt: null, endedAt: now, endReason: r.converted ? 'converted' : `state:${r.state}` } });
        return 1;
      });
    }
  }
  // 到期的参与（启用的节奏），分批处理 / due enrollments of active cadences, in batches
  const byId = new Map(cadences.map((c) => [c.id, c]));
  let cursor = new Date(0);
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const due = await prisma.cadenceEnrollment.findMany({
      where: {
        status: CadenceStatus.ACTIVE,
        nextDueAt: { lte: now },
        cadenceId: { in: [...byId.keys()] },
        OR: [{ nextDueAt: { gt: cursor } }, { nextDueAt: cursor, id: { gt: lastId } }],
      },
      select: { id: true, nextDueAt: true, cadenceId: true },
      orderBy: [{ nextDueAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH,
    });
    if (!due.length) break;
    for (const d of due) {
      try {
        const n = await prisma.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cadence_enrollments WHERE id = ${d.id}::uuid AND status = 'ACTIVE' AND next_due_at <= ${now} FOR UPDATE SKIP LOCKED`;
          if (!locked) return -1;
          const e = await tx.cadenceEnrollment.findUniqueOrThrow({ where: { id: d.id } });
          return processEnrollment(tx, e, byId.get(d.cadenceId)!, now, null);
        });
        if (n >= 0) {
          result.processed += 1;
          result.activities += n;
        }
      } catch (err) {
        result.failures.push({ enrollmentId: d.id, error: (err as Error).message.slice(0, 200) });
      }
    }
    const last = due[due.length - 1]!;
    cursor = last.nextDueAt!;
    lastId = last.id;
  }
  return result;
}
