/**
 * 线索模块应用服务。所有查询都以服务端会话中的 organizationId 为作用域。
 * Leads application service. Every query is scoped by the session's organizationId.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { LeadStatus } from '@/generated/prisma/enums';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { notFound } from '../errors';
import { containsText, listQuery, optionalEmail, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';

/** 线索来源（固定字典，前端用 i18n 显示）/ Lead sources (fixed dictionary, displayed via i18n) */
export const LEAD_SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] as const;

const fields = {
  name: requiredText(100),
  company: optionalText(200),
  title: optionalText(100),
  phone: optionalText(50),
  mobile: optionalText(50),
  email: optionalEmail,
  source: z.enum(LEAD_SOURCES).nullish().transform((v) => v ?? null),
  status: z.enum(LeadStatus).default(LeadStatus.NEW),
  description: optionalText(5000),
  ownerId: optionalUuid.optional(),
};

/** 新建线索输入 / Create input */
export const leadCreateSchema = z.strictObject(fields);
/** 更新线索输入（部分字段）/ Update input (partial) */
export const leadUpdateSchema = z.strictObject({ ...fields, status: z.enum(LeadStatus) }).partial();
/** 列表查询 / List query */
export const leadListSchema = listQuery.extend({
  status: z.enum(LeadStatus).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  ownerId: z.uuid().optional(),
});

const include = { owner: { select: { id: true, name: true } } } satisfies Prisma.LeadInclude;

/**
 * 分页搜索线索。
 * Search leads with pagination.
 */
export async function listLeads(ctx: AuthContext, query: z.infer<typeof leadListSchema>): Promise<Page<unknown>> {
  const where: Prisma.LeadWhereInput = {
    organizationId: ctx.organizationId,
    status: query.status,
    source: query.source,
    ownerId: query.ownerId,
  };
  if (query.q) {
    const contains = containsText(query.q);
    where.OR = [{ name: contains }, { company: contains }, { email: contains }, { phone: contains }, { mobile: contains }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.lead.findMany({
      where,
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.lead.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 获取线索详情；跨组织访问返回 404。
 * Get a lead; cross-organization access yields 404.
 */
export async function getLead(ctx: AuthContext, id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, organizationId: ctx.organizationId }, include });
  if (!lead) throw notFound();
  return lead;
}

/**
 * 新建线索；负责人默认为当前用户。
 * Create a lead; the owner defaults to the current user.
 */
export async function createLead(ctx: AuthContext, input: z.infer<typeof leadCreateSchema>) {
  const { ownerId, ...data } = input;
  return prisma.lead.create({
    data: { ...data, organizationId: ctx.organizationId, ownerId: await resolveOwner(ctx.organizationId, ownerId, ctx.userId) },
    include,
  });
}

/**
 * 更新线索。
 * Update a lead.
 */
export async function updateLead(ctx: AuthContext, id: string, input: z.infer<typeof leadUpdateSchema>) {
  const current = await getLead(ctx, id);
  const { ownerId, ...data } = input;
  return prisma.lead.update({
    where: { id: current.id },
    data: { ...data, ownerId: await resolveOwner(ctx.organizationId, ownerId, current.ownerId) },
    include,
  });
}

/**
 * 删除线索（关联跟进记录随之删除）。
 * Delete a lead (its activities are removed with it).
 */
export async function deleteLead(ctx: AuthContext, id: string): Promise<void> {
  const { count } = await prisma.lead.deleteMany({ where: { id, organizationId: ctx.organizationId } });
  if (count === 0) throw notFound();
}
