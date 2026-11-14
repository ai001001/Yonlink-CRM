/**
 * 线索模块应用服务。所有查询都以服务端会话中的 organizationId 为作用域。
 * Leads application service. Every query is scoped by the session's organizationId.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { DealStage, LeadStatus } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, requirePermission, visible } from '../permissions';
import { ApiError, notFound } from '../errors';
import { detachSharedActivities } from './activities';
import { amountSchema, CURRENCIES, dateOnly } from './deals';
import { notifyAssigned } from './notifications';
import { recycle } from './recycle-bin';
import { tagFilter, tagsInclude } from './tags';
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
  // “已转化”只能经转化流程设置 / CONVERTED can only be set by the conversion flow
  status: z.enum(LeadStatus).exclude([LeadStatus.CONVERTED]).default(LeadStatus.NEW),
  description: optionalText(5000),
  ownerId: optionalUuid.optional(),
};

/** 新建线索输入 / Create input */
export const leadCreateSchema = z.strictObject(fields);
/** 更新线索输入（部分字段）/ Update input (partial) */
export const leadUpdateSchema = z.strictObject({ ...fields, status: z.enum(LeadStatus).exclude([LeadStatus.CONVERTED]) }).partial();
/** 列表查询 / List query */
export const leadListSchema = listQuery.extend({
  status: z.enum(LeadStatus).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  ownerId: z.uuid().optional(),
  tagId: z.uuid().optional(),
});

const include = {
  owner: { select: { id: true, name: true } },
  convertedAccount: { select: { id: true, name: true } },
  convertedContact: { select: { id: true, name: true } },
  convertedDeal: { select: { id: true, name: true } },
  tags: tagsInclude,
} satisfies Prisma.LeadInclude;

/**
 * 列表与导出共用的查询条件（可见范围 + 筛选 + 搜索）。
 * Query conditions shared by the list and the export (visibility + filters + search).
 */
export function leadWhere(ctx: AuthContext, query: Omit<z.infer<typeof leadListSchema>, 'page' | 'pageSize'>): Prisma.LeadWhereInput {
  // 可见范围与筛选条件同时满足 / visibility AND filters
  const where: Prisma.LeadWhereInput = { AND: [visible(ctx), { status: query.status, source: query.source, ownerId: query.ownerId }, tagFilter(query.tagId)] };
  if (query.q) {
    const contains = containsText(query.q);
    where.OR = [{ name: contains }, { company: contains }, { email: contains }, { phone: contains }, { mobile: contains }];
  }
  return where;
}

/**
 * 分页搜索线索。
 * Search leads with pagination.
 */
export async function listLeads(ctx: AuthContext, query: z.infer<typeof leadListSchema>): Promise<Page<unknown>> {
  const where = leadWhere(ctx, query);
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
  const lead = await prisma.lead.findFirst({ where: { id, ...visible(ctx) }, include });
  if (!lead) throw notFound();
  return lead;
}

/**
 * 新建线索；负责人默认为当前用户。
 * Create a lead; the owner defaults to the current user.
 */
export async function createLead(ctx: AuthContext, input: z.infer<typeof leadCreateSchema>) {
  const { ownerId, ...data } = input;
  requirePermission(ctx, 'record.create');
  assertOwnerAssignable(ctx, ownerId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({ data: { ...data, organizationId: ctx.organizationId, ownerId: owner }, include });
    await audit(tx, { ...by(ctx), action: 'lead.create', entityType: 'lead', entityId: lead.id, changes: { after: snapshot('lead', lead) } });
    await notifyAssigned(tx, ctx, { entity: 'lead', id: lead.id }, lead.name, lead.ownerId, null);
    return lead;
  });
}

/**
 * 更新线索。
 * Update a lead.
 */
export async function updateLead(ctx: AuthContext, id: string, input: z.infer<typeof leadUpdateSchema>) {
  const current = await getLead(ctx, id);
  assertCanUpdate(ctx, current);
  const { ownerId, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  if (current.convertedAt && data.status !== undefined) {
    throw new ApiError(409, 'CONFLICT', 'Lead already converted', { status: ['Converted leads keep their status'] });
  }
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.update({ where: { id: current.id }, data: { ...data, ownerId: owner }, include });
    await notifyAssigned(tx, ctx, { entity: 'lead', id: lead.id }, lead.name, lead.ownerId, current.ownerId);
    const fields = diff('lead', current, lead);
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'lead.update', entityType: 'lead', entityId: lead.id, changes: { fields } });
    }
    return lead;
  });
}

/**
 * 删除线索：仅关联该线索的跟进随之删除，共享跟进解除关联后保留。
 * Delete a lead: lead-only activities are removed, shared ones are unlinked and kept.
 */
export async function deleteLead(ctx: AuthContext, id: string): Promise<void> {
  assertCanDelete(ctx);
  await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({ where: { id, ...visible(ctx) } });
    if (!lead) throw notFound();
    // 先放入回收站（快照），再删除 / snapshot into the recycle bin, then delete
    await recycle(tx, ctx, 'lead', id, lead.company ? `${lead.name}（${lead.company}）` : lead.name);
    await detachSharedActivities(tx, ctx.organizationId, 'leadId', id);
    const { count } = await tx.lead.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (count === 0) throw notFound();
    await audit(tx, { ...by(ctx), action: 'lead.delete', entityType: 'lead', entityId: id, changes: { before: snapshot('lead', lead), recycled: true } });
  });
}

/** 线索转化输入 / Lead conversion input */
export const leadConvertSchema = z.strictObject({
  /** 新建客户（默认名称取公司名或姓名）或关联已有客户 / new account (defaults to company or name) or an existing one */
  account: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('new'), name: requiredText(200).optional() }),
    z.strictObject({ mode: z.literal('existing'), accountId: z.uuid() }),
  ]),
  /** 可选：同时创建商机 / optional deal created with the conversion */
  deal: z
    .strictObject({
      name: requiredText(200),
      amount: amountSchema.default('0'),
      currency: z.enum(CURRENCIES).default('CNY'),
      stage: z.enum(DealStage).default(DealStage.QUALIFICATION),
      expectedCloseDate: dateOnly
        .nullish()
        .transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null)),
    })
    .nullish()
    .transform((v) => v ?? null),
});

/**
 * 线索转化：在同一事务中创建/关联客户、创建联系人、可选创建商机，迁移跟进记录，并把线索标记为已转化。
 * 转化不可逆；重复转化返回 409（并发时由条件更新保证只成功一次）。
 * Convert a lead: in one transaction create or reuse an account, create a contact, optionally a deal,
 * re-link the lead's activities and mark the lead converted. Irreversible; a second conversion yields 409
 * (a conditional update guarantees a single winner under concurrency).
 */
export async function convertLead(ctx: AuthContext, id: string, input: z.infer<typeof leadConvertSchema>) {
  const org = ctx.organizationId;
  const lead = await getLead(ctx, id);
  // 转化会修改线索并新建记录 / conversion edits the lead and creates records
  assertCanUpdate(ctx, lead);
  requirePermission(ctx, 'record.create');
  if (lead.convertedAt) throw new ApiError(409, 'CONFLICT', 'Lead already converted', { lead: ['Already converted'] });
  const ownerId = lead.ownerId ?? ctx.userId;

  return prisma.$transaction(async (tx) => {
    // 客户 / account
    let account: { id: string; name: string };
    let isNewAccount = false;
    if (input.account.mode === 'existing') {
      const found = await tx.account.findFirst({ where: { id: input.account.accountId, ...visible(ctx) }, select: { id: true, name: true } });
      if (!found) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid account', { 'account.accountId': ['Account not found'] });
      account = found;
    } else {
      isNewAccount = true;
      const created = await tx.account.create({
        data: { organizationId: org, ownerId, name: input.account.name ?? lead.company ?? lead.name, phone: lead.phone },
      });
      account = { id: created.id, name: created.name };
      await audit(tx, { ...by(ctx), action: 'account.create', entityType: 'account', entityId: created.id, changes: { after: snapshot('account', created), via: 'lead.convert' } });
    }

    // 联系人：新客户或客户尚无主要联系人时设为主要联系人 / contact: primary for a new account or when none exists
    const hasPrimary = !isNewAccount && (await tx.contact.count({ where: { organizationId: org, accountId: account.id, isPrimary: true } })) > 0;
    const contact = await tx.contact.create({
      data: {
        organizationId: org,
        accountId: account.id,
        name: lead.name,
        title: lead.title,
        phone: lead.mobile ?? lead.phone,
        email: lead.email,
        isPrimary: !hasPrimary,
      },
    });
    await audit(tx, { ...by(ctx), action: 'contact.create', entityType: 'contact', entityId: contact.id, changes: { after: snapshot('contact', contact), via: 'lead.convert' } });

    // 商机（可选）/ optional deal
    const deal = input.deal ? await tx.deal.create({ data: { ...input.deal, organizationId: org, ownerId, accountId: account.id } }) : null;
    if (deal) {
      await audit(tx, { ...by(ctx), action: 'deal.create', entityType: 'deal', entityId: deal.id, changes: { after: snapshot('deal', deal), via: 'lead.convert' } });
    }

    // 跟进记录关联到客户与商机（不覆盖已有关联）/ link activities to the account and deal without overwriting
    await tx.activity.updateMany({ where: { organizationId: org, leadId: lead.id, accountId: null }, data: { accountId: account.id } });
    if (deal) {
      await tx.activity.updateMany({ where: { organizationId: org, leadId: lead.id, dealId: null }, data: { dealId: deal.id } });
    }

    // 条件更新防止并发重复转化 / conditional update prevents concurrent double conversion
    const { count } = await tx.lead.updateMany({
      where: { id: lead.id, organizationId: org, convertedAt: null },
      data: {
        status: LeadStatus.CONVERTED,
        convertedAt: new Date(),
        convertedAccountId: account.id,
        convertedContactId: contact.id,
        convertedDealId: deal?.id ?? null,
      },
    });
    if (count === 0) throw new ApiError(409, 'CONFLICT', 'Lead already converted', { lead: ['Already converted'] });

    await audit(tx, {
      ...by(ctx),
      action: 'lead.convert',
      entityType: 'lead',
      entityId: lead.id,
      changes: { accountMode: input.account.mode, accountId: account.id, contactId: contact.id, dealId: deal?.id ?? null },
    });

    const converted = await tx.lead.findUniqueOrThrow({ where: { id: lead.id }, include });
    return {
      lead: converted,
      account,
      contact: { id: contact.id, name: contact.name },
      deal: deal ? { id: deal.id, name: deal.name } : null,
    };
  });
}
