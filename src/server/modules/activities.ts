/**
 * 跟进记录（电话/会议/拜访/任务）应用服务。
 * Activities (call / meeting / visit / task) application service.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { ActivityType } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, requirePermission, visible } from '../permissions';
import { ApiError, notFound } from '../errors';
import { containsText, listQuery, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';

const activityFields = {
  type: z.enum(ActivityType),
  subject: requiredText(200),
  content: optionalText(10000),
  dueAt: z.iso
    .datetime({ offset: true })
    .nullish()
    .transform((v) => (v ? new Date(v) : null)),
  completed: z.boolean().default(false),
  accountId: optionalUuid,
  leadId: optionalUuid,
  dealId: optionalUuid,
  ownerId: optionalUuid.optional(),
};

/** 新建跟进记录 / Create activity */
export const activityCreateSchema = z.strictObject(activityFields);

/** 更新跟进记录 / Update activity */
export const activityUpdateSchema = z.strictObject({ ...activityFields, completed: z.boolean() }).partial();

/** 跟进记录列表查询 / Activity list query */
export const activityListSchema = listQuery.extend({
  type: z.enum(ActivityType).optional(),
  completed: z.enum(['true', 'false']).optional(),
  accountId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  /** createdAt：最新优先；dueAt：截止时间升序（无截止时间排后）/ newest first, or due date ascending */
  sort: z.enum(['createdAt', 'dueAt']).default('createdAt'),
});

/** 返回时附带的关联信息 / Related data included in responses */
export const activityInclude = {
  owner: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  lead: { select: { id: true, name: true } },
  deal: { select: { id: true, name: true } },
} satisfies Prisma.ActivityInclude;

/**
 * 校验关联的客户/线索/商机均属于当前组织。
 * Ensure the related account / lead / deal belong to the current organization.
 */
export async function assertRelated(
  ctx: AuthContext,
  ids: { accountId?: string | null; leadId?: string | null; dealId?: string | null },
): Promise<void> {
  // 关联对象必须对当前用户可见 / related records must be visible to the user
  const scope = visible(ctx);
  const errors: Record<string, string[]> = {};
  const [account, lead, deal] = await Promise.all([
    ids.accountId ? prisma.account.count({ where: { id: ids.accountId, ...scope } }) : 1,
    ids.leadId ? prisma.lead.count({ where: { id: ids.leadId, ...scope } }) : 1,
    ids.dealId ? prisma.deal.count({ where: { id: ids.dealId, ...scope } }) : 1,
  ]);
  if (!account) errors.accountId = ['Account not found'];
  if (!lead) errors.leadId = ['Lead not found'];
  if (!deal) errors.dealId = ['Deal not found'];
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid related record', errors);
}

/**
 * 列表与导出共用的查询条件（可见范围 + 筛选 + 搜索）。
 * Query conditions shared by the list and the export (visibility + filters + search).
 */
export function activityWhere(ctx: AuthContext, query: Omit<z.infer<typeof activityListSchema>, 'page' | 'pageSize'>): Prisma.ActivityWhereInput {
  // 可见范围必须用 AND 组合，不能被 ownerId 筛选覆盖 / visibility is ANDed so the ownerId filter cannot override it
  const where: Prisma.ActivityWhereInput = {
    AND: [
      visible(ctx),
      {
        type: query.type,
        completed: query.completed === undefined ? undefined : query.completed === 'true',
        accountId: query.accountId,
        leadId: query.leadId,
        dealId: query.dealId,
        ownerId: query.ownerId,
      },
    ],
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ subject: c }, { content: c }];
  }
  return where;
}

/**
 * 分页查询跟进记录（默认最新优先，可按截止时间排序）。
 * List activities with pagination (newest first by default, or by due date).
 */
export async function listActivities(ctx: AuthContext, query: z.infer<typeof activityListSchema>): Promise<Page<unknown>> {
  const where = activityWhere(ctx, query);
  const [items, total] = await prisma.$transaction([
    prisma.activity.findMany({
      where,
      include: activityInclude,
      orderBy:
        query.sort === 'dueAt'
          ? [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }]
          : [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.activity.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 新建跟进记录；负责人默认当前用户；已完成时记录完成时间。
 * Create an activity; owner defaults to me; completed activities get completedAt.
 */
export async function createActivity(ctx: AuthContext, input: z.infer<typeof activityCreateSchema>) {
  const { ownerId, ...data } = input;
  requirePermission(ctx, 'record.create');
  assertOwnerAssignable(ctx, ownerId);
  await assertRelated(ctx, data);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  return prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: { ...data, organizationId: ctx.organizationId, ownerId: owner, completedAt: data.completed ? new Date() : null },
      include: activityInclude,
    });
    await audit(tx, { ...by(ctx), action: 'activity.create', entityType: 'activity', entityId: activity.id, changes: { after: snapshot('activity', activity) } });
    return activity;
  });
}

/**
 * 跟进记录详情；跨组织返回 404。
 * Activity detail; cross-organization access yields 404.
 */
export async function getActivity(ctx: AuthContext, id: string) {
  const activity = await prisma.activity.findFirst({ where: { id, ...visible(ctx) }, include: activityInclude });
  if (!activity) throw notFound();
  return activity;
}

/**
 * 更新跟进记录；完成状态变化时同步完成时间。
 * Update an activity; completedAt follows changes of the completed flag.
 */
export async function updateActivity(ctx: AuthContext, id: string, input: z.infer<typeof activityUpdateSchema>) {
  const current = await getActivity(ctx, id);
  assertCanUpdate(ctx, current);
  const { ownerId, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  await assertRelated(ctx, data);
  let completedAt = current.completedAt;
  if (data.completed === true && !current.completed) completedAt = new Date();
  if (data.completed === false) completedAt = null;
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  return prisma.$transaction(async (tx) => {
    const activity = await tx.activity.update({ where: { id: current.id }, data: { ...data, completedAt, ownerId: owner }, include: activityInclude });
    const fields = diff('activity', current, activity);
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'activity.update', entityType: 'activity', entityId: activity.id, changes: { fields } });
    }
    return activity;
  });
}

/**
 * 删除跟进记录。
 * Delete an activity.
 */
export async function deleteActivity(ctx: AuthContext, id: string): Promise<void> {
  assertCanDelete(ctx);
  await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.findFirst({ where: { id, ...visible(ctx) } });
    if (!activity) throw notFound();
    await tx.activity.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'activity.delete', entityType: 'activity', entityId: id, changes: { before: snapshot('activity', activity) } });
  });
}

type RelationField = 'accountId' | 'leadId' | 'dealId';

/**
 * 删除客户/线索/商机前调用：同时关联其他对象的跟进记录只解除该关联而保留，
 * 其余仅关联该记录的跟进随外键级联删除。
 * Call before deleting an account / lead / deal: activities that also reference another
 * record are kept and only unlinked; activities referencing just this record cascade.
 * @param tx 事务客户端 / transaction client
 * @param organizationId 当前组织 / current organization
 * @param field 关联字段 / relation field
 * @param id 将被删除的记录 / record being deleted
 */
export async function detachSharedActivities(
  tx: Prisma.TransactionClient,
  organizationId: string,
  field: RelationField,
  id: string,
): Promise<void> {
  const others = (['accountId', 'leadId', 'dealId'] as const).filter((f) => f !== field);
  await tx.activity.updateMany({
    where: { organizationId, [field]: id, OR: others.map((f) => ({ [f]: { not: null } })) },
    data: { [field]: null },
  });
}
