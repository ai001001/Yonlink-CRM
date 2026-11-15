/**
 * 市场活动（参考 Zoho CRM Campaigns）：记录展会、广告等活动；线索与商机可关联来源活动，统计带来的线索、转化、
 * 商机、在手与赢单金额以及投入产出比（金额按今天的汇率折合人民币，缺少汇率的币种列出）。
 * - 所有登录用户可查看活动；新建、修改、删除需 campaign.manage（管理员、经理）；有关联线索或商机的活动不能删除。
 * - 统计遵循可见范围（销售代表只统计自己负责的线索与商机）。
 * - 新建、修改、删除写审计；线索、商机关联活动随其自身修改审计。
 * Campaigns (cf. Zoho CRM Campaigns): leads and deals may name a source campaign; statistics cover leads,
 * conversions, deals, pipeline, won revenue and ROI in CNY at today's rates (missing rates are listed). Everyone
 * views; campaign.manage (admins, managers) creates, updates and deletes; campaigns with linked records cannot be
 * deleted. Statistics follow visibility. Changes are audited.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { CampaignStatus, CampaignType } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission, visible } from '../permissions';
import { containsText, listQuery, optionalText, requiredText, resolveOwner, type Page } from '../validation';
import { amountSchema, CURRENCIES, dateOnly } from './deals';
import { BASE_CURRENCY, ratesOn, sumInBase, toBase } from './exchange-rates';

const date = dateOnly.nullish().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null));
const money = amountSchema.nullish().transform((v) => v ?? null);

const fields = {
  name: requiredText(100),
  type: z.enum(CampaignType),
  status: z.enum(CampaignStatus).default(CampaignStatus.PLANNED),
  startDate: date,
  endDate: date,
  currency: z.enum(CURRENCIES).default('CNY'),
  budget: money,
  actualCost: money,
  description: optionalText(5000),
  ownerId: z.uuid().nullish(),
};

/** 新建活动 / Create a campaign */
export const campaignCreateSchema = z.strictObject(fields);
/** 修改活动 / Update a campaign */
export const campaignUpdateSchema = z.strictObject({ ...fields, status: z.enum(CampaignStatus) }).partial();
/** 列表查询 / List query */
export const campaignListSchema = listQuery.extend({
  status: z.enum(CampaignStatus).optional(),
  type: z.enum(CampaignType).optional(),
});

const select = {
  id: true,
  name: true,
  type: true,
  status: true,
  startDate: true,
  endDate: true,
  currency: true,
  budget: true,
  actualCost: true,
  description: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true } },
} satisfies Prisma.CampaignSelect;

type CampaignRow = Prisma.CampaignGetPayload<{ select: typeof select }>;

/** 结束日期不早于开始日期 / the end date is not before the start date */
function assertDates(start: Date | null | undefined, end: Date | null | undefined) {
  if (start && end && end < start) throw new ApiError(400, 'VALIDATION_ERROR', 'End before start', { endDate: ['before_start'] });
}

/** 名称重复 / duplicate name */
const nameTaken = () => new ApiError(409, 'CONFLICT', 'Campaign name already exists', { name: ['taken'] });

/**
 * 批量计算活动统计（遵循可见范围）。
 * Statistics for several campaigns (visibility-aware).
 */
async function statsFor(ctx: AuthContext, campaigns: CampaignRow[]) {
  const ids = campaigns.map((c) => c.id);
  const scope = visible(ctx);
  const [leads, deals, rates] = await Promise.all([
    prisma.lead.groupBy({ by: ['campaignId', 'status'], where: { ...scope, campaignId: { in: ids } }, _count: { _all: true }, orderBy: [{ campaignId: 'asc' }, { status: 'asc' }] }),
    prisma.deal.groupBy({ by: ['campaignId', 'stage', 'currency'], where: { ...scope, campaignId: { in: ids } }, _count: { _all: true }, _sum: { amount: true }, orderBy: [{ campaignId: 'asc' }, { stage: 'asc' }, { currency: 'asc' }] }),
    ratesOn(ctx.organizationId, new Date()),
  ]);
  const count = (x: { _count?: { _all?: number } | true }) => (typeof x._count === 'object' ? (x._count._all ?? 0) : 0);
  return new Map(
    campaigns.map((c) => {
      const l = leads.filter((x) => x.campaignId === c.id);
      const d = deals.filter((x) => x.campaignId === c.id);
      const sumBy = (rows: typeof d) => {
        const m = new Map<string, Prisma.Decimal>();
        for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? new Prisma.Decimal(0)).plus(r._sum.amount ?? 0));
        return m;
      };
      const open = sumInBase(sumBy(d.filter((x) => x.stage !== 'CLOSED_WON' && x.stage !== 'CLOSED_LOST')), rates);
      const won = sumInBase(sumBy(d.filter((x) => x.stage === 'CLOSED_WON')), rates);
      const costRate = rates.get(c.currency);
      const cost = c.actualCost ? (costRate ? toBase(c.actualCost, costRate) : null) : new Prisma.Decimal(0);
      const missing = [...new Set([...open.missing, ...won.missing, ...(c.actualCost && !costRate ? [c.currency] : [])])].sort();
      const roi = cost && cost.gt(0) ? Math.round(new Prisma.Decimal(won.total).minus(cost).div(cost).mul(1000).toNumber()) / 10 : null;
      const leadTotal = l.reduce((s, x) => s + count(x), 0);
      const converted = l.filter((x) => x.status === 'CONVERTED').reduce((s, x) => s + count(x), 0);
      return [
        c.id,
        {
          leads: leadTotal,
          convertedLeads: converted,
          conversionRate: leadTotal ? Math.round((converted / leadTotal) * 1000) / 10 : null,
          deals: d.reduce((s, x) => s + count(x), 0),
          wonDeals: d.filter((x) => x.stage === 'CLOSED_WON').reduce((s, x) => s + count(x), 0),
          openAmount: open.total,
          wonAmount: won.total,
          costInBase: cost ? cost.toFixed(2) : null,
          roi,
          baseCurrency: BASE_CURRENCY,
          missing,
        },
      ];
    }),
  );
}

/**
 * 分页搜索活动（名称、说明），附统计。
 * Search campaigns (name, description) with statistics, paginated.
 */
export async function listCampaigns(ctx: AuthContext, query: z.infer<typeof campaignListSchema>): Promise<Page<unknown>> {
  const where: Prisma.CampaignWhereInput = { organizationId: ctx.organizationId, status: query.status, type: query.type };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { description: c }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.campaign.findMany({ where, select, orderBy: [{ startDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.campaign.count({ where }),
  ]);
  const stats = await statsFor(ctx, items);
  return { items: items.map((c) => ({ ...c, stats: stats.get(c.id) })), total, page: query.page, pageSize: query.pageSize };
}

/**
 * 供线索、商机选择的活动（不含已取消，但包含指定的当前值），按名称排序。
 * Campaign options for leads and deals (cancelled excluded unless it is the current value), by name.
 */
export async function campaignOptions(ctx: AuthContext, include?: string) {
  return prisma.campaign.findMany({
    where: { organizationId: ctx.organizationId, OR: [{ status: { not: CampaignStatus.CANCELLED } }, ...(include ? [{ id: include }] : [])] },
    select: { id: true, name: true, status: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * 活动详情：资料、统计、最近关联的线索与商机（各 20 条，遵循可见范围）。
 * Campaign detail: fields, statistics and recent linked leads and deals (20 each, visibility-aware).
 */
export async function getCampaign(ctx: AuthContext, id: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: ctx.organizationId }, select });
  if (!campaign) throw notFound();
  const scope = visible(ctx);
  const [stats, leads, deals] = await Promise.all([
    statsFor(ctx, [campaign]),
    prisma.lead.findMany({ where: { ...scope, campaignId: id }, select: { id: true, name: true, company: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.deal.findMany({ where: { ...scope, campaignId: id }, select: { id: true, name: true, stage: true, amount: true, currency: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  return { ...campaign, stats: stats.get(id), leads, deals };
}

/**
 * 新建活动（需 campaign.manage；名称组织内唯一）。
 * Create a campaign (campaign.manage; names are unique per organization).
 */
export async function createCampaign(ctx: AuthContext, input: z.infer<typeof campaignCreateSchema>) {
  requirePermission(ctx, 'campaign.manage');
  assertDates(input.startDate, input.endDate);
  const ownerId = await resolveOwner(ctx.organizationId, input.ownerId, ctx.userId);
  if (await prisma.campaign.count({ where: { organizationId: ctx.organizationId, name: input.name } })) throw nameTaken();
  const id = await prisma.$transaction(async (tx) => {
    const c = await tx.campaign.create({ data: { ...input, ownerId, organizationId: ctx.organizationId } });
    await audit(tx, { ...by(ctx), action: 'campaign.create', entityType: 'campaign', entityId: c.id, changes: { after: snapshot('campaign', c) } });
    return c.id;
  });
  return getCampaign(ctx, id);
}

/**
 * 修改活动（需 campaign.manage）。
 * Update a campaign (campaign.manage).
 */
export async function updateCampaign(ctx: AuthContext, id: string, input: z.infer<typeof campaignUpdateSchema>) {
  requirePermission(ctx, 'campaign.manage');
  const current = await prisma.campaign.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!current) throw notFound();
  assertDates(input.startDate === undefined ? current.startDate : input.startDate, input.endDate === undefined ? current.endDate : input.endDate);
  const { ownerId, ...data } = input;
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  if (data.name && data.name !== current.name && (await prisma.campaign.count({ where: { organizationId: ctx.organizationId, name: data.name } }))) throw nameTaken();
  await prisma.$transaction(async (tx) => {
    const c = await tx.campaign.update({ where: { id }, data: { ...data, ownerId: owner } });
    const changed = diff('campaign', current, c);
    if (Object.keys(changed).length) await audit(tx, { ...by(ctx), action: 'campaign.update', entityType: 'campaign', entityId: id, changes: { fields: changed } });
  });
  return getCampaign(ctx, id);
}

/**
 * 删除活动（需 campaign.manage）；有关联线索或商机（按全部记录计，不按可见范围）时 409。
 * Delete a campaign (campaign.manage); 409 while any lead or deal links to it (all records, not just visible ones).
 */
export async function deleteCampaign(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'campaign.manage');
  await prisma.$transaction(async (tx) => {
    const c = await tx.campaign.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!c) throw notFound();
    const [leads, deals] = await Promise.all([
      tx.lead.count({ where: { organizationId: ctx.organizationId, campaignId: id } }),
      tx.deal.count({ where: { organizationId: ctx.organizationId, campaignId: id } }),
    ]);
    if (leads || deals) throw new ApiError(409, 'CONFLICT', 'Campaign has linked records', { campaign: [`leads:${leads}`, `deals:${deals}`] });
    await tx.campaign.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'campaign.delete', entityType: 'campaign', entityId: id, changes: { before: snapshot('campaign', c) } });
  });
}
