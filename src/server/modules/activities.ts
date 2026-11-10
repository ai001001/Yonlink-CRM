/**
 * 跟进记录（电话/会议/拜访/任务）应用服务。
 * Activities (call / meeting / visit / task) application service.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { ActivityType } from '@/generated/prisma/enums';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
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

/** 跟进记录列表查询 / Activity list query */
export const activityListSchema = listQuery.extend({
  type: z.enum(ActivityType).optional(),
  completed: z.enum(['true', 'false']).optional(),
  accountId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
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
  const org = ctx.organizationId;
  const errors: Record<string, string[]> = {};
  const [account, lead, deal] = await Promise.all([
    ids.accountId ? prisma.account.count({ where: { id: ids.accountId, organizationId: org } }) : 1,
    ids.leadId ? prisma.lead.count({ where: { id: ids.leadId, organizationId: org } }) : 1,
    ids.dealId ? prisma.deal.count({ where: { id: ids.dealId, organizationId: org } }) : 1,
  ]);
  if (!account) errors.accountId = ['Account not found'];
  if (!lead) errors.leadId = ['Lead not found'];
  if (!deal) errors.dealId = ['Deal not found'];
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid related record', errors);
}

/**
 * 分页查询跟进记录：未完成且有截止时间的按截止时间排序，否则最新优先。
 * List activities with pagination, newest first.
 */
export async function listActivities(ctx: AuthContext, query: z.infer<typeof activityListSchema>): Promise<Page<unknown>> {
  const where: Prisma.ActivityWhereInput = {
    organizationId: ctx.organizationId,
    type: query.type,
    completed: query.completed === undefined ? undefined : query.completed === 'true',
    accountId: query.accountId,
    leadId: query.leadId,
    dealId: query.dealId,
    ownerId: query.ownerId,
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ subject: c }, { content: c }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.activity.findMany({
      where,
      include: activityInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
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
  await assertRelated(ctx, data);
  return prisma.activity.create({
    data: {
      ...data,
      organizationId: ctx.organizationId,
      ownerId: await resolveOwner(ctx.organizationId, ownerId, ctx.userId),
      completedAt: data.completed ? new Date() : null,
    },
    include: activityInclude,
  });
}
