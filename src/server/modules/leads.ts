/**
 * 线索模块应用服务。所有查询都以服务端会话中的 organizationId 为作用域。
 * Leads application service. Every query is scoped by the session's organizationId.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { DealStage, LeadStatus } from '@/generated/prisma/enums';
import { audit, by, diff, setActor, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, requirePermission, visible } from '../permissions';
import { ApiError, notFound } from '../errors';
import { assertOption, lockCustomOption, picklistCode } from './picklists';
import { detachSharedActivities } from './activities';
import { assertCampaign } from './campaign-links';
import { LEAD_SOURCES } from './dictionaries';
import { amountSchema, CURRENCIES, dateOnly } from './deals';
import { notifyAssigned } from './notifications';
import { recycle } from './recycle-bin';
import { gradeRange, scoreListFields, scoreOrder } from './scoring-grades';
import { tagFilter, tagsInclude } from './tags';
import { assertValidRecord } from './validation-rules';
import { customDiff, customInput, resolveCustom } from './custom-fields';
import { territoryMatcher } from './territory-rules';
import { assertNotControlled } from './blueprint-rules';
import { runWorkflows } from './workflows';
import { containsText, listQuery, optionalEmail, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';

/** 线索来源（定义见字典模块）/ Lead sources (defined in the dictionaries module) */
export { LEAD_SOURCES };

const fields = {
  name: requiredText(100),
  company: optionalText(200),
  title: optionalText(100),
  phone: optionalText(50),
  mobile: optionalText(50),
  email: optionalEmail,
  // 来源可为自定义选项，写入时按组织配置检查 / sources may be custom options, checked against the organization's list on write
  source: picklistCode.nullish().transform((v) => v ?? null),
  // “已转化”只能经转化流程设置 / CONVERTED can only be set by the conversion flow
  status: z.enum(LeadStatus).exclude([LeadStatus.CONVERTED]).default(LeadStatus.NEW),
  description: optionalText(5000),
  ownerId: optionalUuid.optional(),
  /** 自定义字段的值 / custom field values */
  custom: customInput,
  /** 来源市场活动 / source campaign */
  campaignId: optionalUuid.optional(),
};

/** 新建线索输入 / Create input */
export const leadCreateSchema = z.strictObject(fields);
/** 更新线索输入（部分字段）/ Update input (partial) */
export const leadUpdateSchema = z.strictObject({ ...fields, status: z.enum(LeadStatus).exclude([LeadStatus.CONVERTED]) }).partial();
/** 列表查询 / List query */
export const leadListSchema = listQuery.extend({
  status: z.enum(LeadStatus).optional(),
  source: picklistCode.optional(),
  ownerId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  ...scoreListFields,
});

const include = {
  owner: { select: { id: true, name: true } },
  convertedAccount: { select: { id: true, name: true } },
  convertedContact: { select: { id: true, name: true } },
  convertedDeal: { select: { id: true, name: true } },
  tags: tagsInclude,
  campaign: { select: { id: true, name: true } },
} satisfies Prisma.LeadInclude;

/**
 * 列表与导出共用的查询条件（可见范围 + 筛选 + 搜索）。
 * Query conditions shared by the list and the export (visibility + filters + search).
 */
export function leadWhere(ctx: AuthContext, query: Omit<z.infer<typeof leadListSchema>, 'page' | 'pageSize'>, score?: Prisma.IntFilter): Prisma.LeadWhereInput {
  // 可见范围与筛选条件同时满足 / visibility AND filters
  const where: Prisma.LeadWhereInput = { AND: [visible(ctx), { status: query.status, source: query.source, ownerId: query.ownerId, campaignId: query.campaignId, score }, tagFilter(query.tagId)] };
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
  const where = leadWhere(ctx, query, await gradeRange(ctx.organizationId, 'LEAD', query.grade));
  const [items, total] = await prisma.$transaction([
    prisma.lead.findMany({
      where,
      include,
      orderBy: scoreOrder<Prisma.LeadOrderByWithRelationInput>(query.sort, [{ createdAt: 'desc' }, { id: 'asc' }]),
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
  const lead = await prisma.lead.findFirst({ where: { id, ...visible(ctx) }, include: { ...include, webForm: { select: { id: true, name: true } } } });
  if (!lead) throw notFound();
  return lead;
}

/**
 * 新建线索；负责人默认为当前用户。
 * Create a lead; the owner defaults to the current user.
 */
export async function createLead(ctx: AuthContext, input: z.infer<typeof leadCreateSchema>) {
  const { ownerId, custom, ...data } = input;
  requirePermission(ctx, 'record.create');
  assertOwnerAssignable(ctx, ownerId);
  await assertCampaign(ctx.organizationId, data.campaignId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  // 选项须为启用的选项 / options must be active
  await assertOption(ctx.organizationId, 'LEAD_SOURCE', data.source, null, 'source');
  await assertOption(ctx.organizationId, 'LEAD_STATUS', data.status, null, 'status');
  // 字段验证规则（按写入后的值）/ validation rules on the values as written
  await assertValidRecord(ctx.organizationId, 'LEAD', { ...data, ownerId: owner });
  const cf = await resolveCustom(ctx.organizationId, 'LEAD', custom, null);
  return prisma.$transaction(async (tx) => {
    // 自定义选项：与删除选项互斥并在事务内复核 / custom options: exclusive with removal, re-checked in the transaction
    await lockCustomOption(tx, ctx.organizationId, 'LEAD_SOURCE', data.source, 'source');
    const lead = await tx.lead.create({ data: { ...data, custom: cf.values as Prisma.InputJsonValue, organizationId: ctx.organizationId, ownerId: owner }, include });
    const customChanges = customDiff(cf.defs, null, cf.values);
    await audit(tx, { ...by(ctx), action: 'lead.create', entityType: 'lead', entityId: lead.id, changes: { after: snapshot('lead', lead), ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    await notifyAssigned(tx, ctx, { entity: 'lead', id: lead.id }, lead.name, lead.ownerId, null);
    // 工作流可能改动记录，执行后返回最新数据 / workflows may change the record; return the latest
    if (await runWorkflows(tx, { entity: 'LEAD', before: null, after: lead, actorId: ctx.userId, meta: ctx.meta })) {
      return tx.lead.findUniqueOrThrow({ where: { id: lead.id }, include });
    }
    return lead;
  });
}

/**
 * 更新线索。
 * Update a lead.
 */
export async function updateLead(ctx: AuthContext, id: string, input: z.infer<typeof leadUpdateSchema>, opts: { expectedStatus?: LeadStatus } = {}) {
  const current = await getLead(ctx, id);
  assertCanUpdate(ctx, current);
  const { ownerId, custom, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  await assertCampaign(ctx.organizationId, data.campaignId);
  if (current.convertedAt && data.status !== undefined) {
    throw new ApiError(409, 'CONFLICT', 'Lead already converted', { status: ['Converted leads keep their status'] });
  }
  // 启用流程蓝图时状态只能通过转换修改 / with a blueprint the status moves only via transitions
  if (data.status !== undefined && data.status !== current.status && !opts.expectedStatus) await assertNotControlled(ctx.organizationId, 'LEAD');
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  // 改为的选项须启用（流程蓝图转换按管理员配置执行，不检查）/ new options must be active (blueprint transitions follow the admin's setup)
  await assertOption(ctx.organizationId, 'LEAD_SOURCE', data.source, current.source, 'source');
  if (!opts.expectedStatus) await assertOption(ctx.organizationId, 'LEAD_STATUS', data.status, current.status, 'status');
  await assertValidRecord(ctx.organizationId, 'LEAD', { ...current, ...data, ownerId: owner });
  const cf = custom === undefined ? null : await resolveCustom(ctx.organizationId, 'LEAD', custom, current.custom);
  return prisma.$transaction(async (tx) => {
    if (opts.expectedStatus) {
      // 转换：锁定记录并确认状态未被并发修改 / transition: lock the row and make sure the status has not changed meanwhile
      const [row] = await tx.$queryRaw<{ status: LeadStatus }[]>`SELECT status FROM leads WHERE id = ${current.id}::uuid FOR UPDATE`;
      if (row?.status !== opts.expectedStatus) throw new ApiError(409, 'CONFLICT', 'The status changed meanwhile', { status: ['state_changed'] });
    }
    // 自定义选项：与删除选项互斥并在事务内复核 / custom options: exclusive with removal, re-checked in the transaction
    if (data.source !== current.source) await lockCustomOption(tx, ctx.organizationId, 'LEAD_SOURCE', data.source, 'source');
    const lead = await tx.lead.update({ where: { id: current.id }, data: { ...data, ownerId: owner, ...(cf ? { custom: cf.values as Prisma.InputJsonValue } : {}) }, include });
    await notifyAssigned(tx, ctx, { entity: 'lead', id: lead.id }, lead.name, lead.ownerId, current.ownerId);
    const fields = diff('lead', current, lead);
    const customChanges = cf ? customDiff(cf.defs, current.custom, cf.values) : {};
    if (Object.keys(fields).length || Object.keys(customChanges).length) {
      await audit(tx, { ...by(ctx), action: 'lead.update', entityType: 'lead', entityId: lead.id, changes: { fields, ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    }
    if (await runWorkflows(tx, { entity: 'LEAD', before: current, after: lead, actorId: ctx.userId, meta: ctx.meta })) {
      return tx.lead.findUniqueOrThrow({ where: { id: lead.id }, include });
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
  // 同时创建的商机：阶段须为启用的选项 / the deal created alongside must use an active stage
  if (input.deal) await assertOption(org, 'DEAL_STAGE', input.deal.stage, null, 'deal.stage');
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
      const data = { ownerId, name: input.account.name ?? lead.company ?? lead.name, phone: lead.phone };
      const created = await tx.account.create({ data: { ...data, ...(await territoryMatcher(org, tx))(data), organizationId: org } });
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
    // 商机继承线索的来源市场活动 / the deal inherits the lead's source campaign
    if (input.deal) await setActor(tx, ctx);
    const deal = input.deal ? await tx.deal.create({ data: { ...input.deal, organizationId: org, ownerId, accountId: account.id, campaignId: lead.campaignId } }) : null;
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
