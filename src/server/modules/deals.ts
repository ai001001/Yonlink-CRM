/**
 * 商机应用服务。金额以十进制字符串传输，数据库为 numeric(18,2)。
 * Deals application service. Amounts travel as decimal strings; stored as numeric(18,2).
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { DealStage } from '@/generated/prisma/enums';
import { audit, by, diff, setActor, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, requirePermission, visible } from '../permissions';
import { ApiError, notFound } from '../errors';
import { assertOption, firstActiveOpenStage } from './picklists';
import { detachSharedActivities } from './activities';
import { assertCampaign } from './campaign-links';
import { removeStaleRoles } from './deal-contact-roles';
import { CURRENCIES } from './dictionaries';
import { notifyAssigned } from './notifications';
import { recycle } from './recycle-bin';
import { gradeRange, scoreListFields, scoreOrder } from './scoring-grades';
import { tagFilter, tagsInclude } from './tags';
import { assertValidRecord } from './validation-rules';
import { customDiff, customInput, resolveCustom } from './custom-fields';
import { assertFieldWrites } from '../field-security';
import { readableDeals, territoryIdsFor, territoryReadScope } from './territory-rules';
import { assertNotControlled } from './blueprint-rules';
import { territoryFilter } from './territory-input';
import { runWorkflows } from './workflows';
import { containsText, listQuery, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';

/** 支持的币种（定义见字典模块）/ Supported currencies (defined in the dictionaries module) */
export { CURRENCIES };

/** 金额：非负，最多 16 位整数、2 位小数 / Amount: non-negative, ≤16 integer digits, ≤2 decimals */
export const amountSchema = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .pipe(z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'Invalid amount'));

/** 日期 YYYY-MM-DD（真实存在的日期）/ Calendar date YYYY-MM-DD (must exist) */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'Invalid date');

const fields = {
  name: requiredText(200),
  accountId: z.uuid(),
  amount: amountSchema.default('0'),
  currency: z.enum(CURRENCIES).default('CNY'),
  /** 不填时为第一个启用的进行中阶段 / defaults to the first active open stage */
  stage: z.enum(DealStage).optional(),
  expectedCloseDate: dateOnly
    .nullish()
    .transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null)),
  description: optionalText(5000),
  ownerId: optionalUuid.optional(),
  /** 自定义字段的值 / custom field values */
  custom: customInput,
  /** 来源市场活动 / source campaign */
  campaignId: optionalUuid.optional(),
};

/** 新建商机 / Create deal */
export const dealCreateSchema = z.strictObject(fields);
/** 更新商机 / Update deal */
export const dealUpdateSchema = z
  .strictObject({ ...fields, amount: amountSchema, currency: z.enum(CURRENCIES), stage: z.enum(DealStage) })
  .partial();
/** 列表查询 / List query */
export const dealListSchema = listQuery.extend({
  stage: z.enum(DealStage).optional(),
  accountId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  /** 客户所在区域（含下级）、NONE 或 MINE / the account's territory (with descendants), NONE or MINE */
  territoryId: territoryFilter,
  ...scoreListFields,
});

const include = {
  owner: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  _count: { select: { lineItems: true } },
  tags: tagsInclude,
  campaign: { select: { id: true, name: true } },
} satisfies Prisma.DealInclude;

/**
 * 确认客户属于当前组织且对当前用户可见。
 * Ensure the account belongs to the organization and is visible to the user.
 */
async function assertAccount(ctx: AuthContext, accountId: string): Promise<void> {
  const n = await prisma.account.count({ where: { id: accountId, ...visible(ctx) } });
  if (!n) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid account', { accountId: ['Account not found'] });
}

/**
 * 列表与导出共用的查询条件（可见范围 + 筛选 + 搜索）。
 * Query conditions shared by the list and the export (visibility + filters + search).
 */
export function dealWhere(
  ctx: AuthContext,
  query: Omit<z.infer<typeof dealListSchema>, 'page' | 'pageSize'>,
  score?: Prisma.IntFilter,
  territories?: string[] | null,
  scope: string[] = [],
): Prisma.DealWhereInput {
  const territory: Prisma.DealWhereInput = territories === undefined ? {} : { account: { territoryId: territories === null ? null : { in: territories } } };
  const where: Prisma.DealWhereInput = { AND: [readableDeals(ctx, scope), { stage: query.stage, accountId: query.accountId, ownerId: query.ownerId, campaignId: query.campaignId, score }, tagFilter(query.tagId), territory] };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { account: { name: c } }];
  }
  return where;
}

/**
 * 分页搜索商机（名称、客户名称），并返回筛选结果按币种的金额合计。
 * Search deals (name, account name) and return per-currency totals for the filter.
 */
export async function listDeals(
  ctx: AuthContext,
  query: z.infer<typeof dealListSchema>,
): Promise<Page<unknown> & { sums: { currency: string; amount: string }[] }> {
  const where = dealWhere(ctx, query, await gradeRange(ctx.organizationId, 'DEAL', query.grade), await territoryIdsFor(ctx, query.territoryId), await territoryReadScope(ctx));
  const [items, total, sums] = await prisma.$transaction([
    prisma.deal.findMany({
      where,
      include,
      orderBy: scoreOrder<Prisma.DealOrderByWithRelationInput>(query.sort, [{ createdAt: 'desc' }, { id: 'asc' }]),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.deal.count({ where }),
    prisma.deal.groupBy({ by: ['currency'], where, _sum: { amount: true }, orderBy: { currency: 'asc' } }),
  ]);
  return {
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    sums: sums.map((s) => ({ currency: s.currency, amount: (s._sum?.amount ?? 0).toString() })),
  };
}

/**
 * 商机详情；跨组织返回 404。
 * Deal detail; cross-organization access yields 404.
 */
export async function getDeal(ctx: AuthContext, id: string) {
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id }, readableDeals(ctx, await territoryReadScope(ctx))] }, include });
  if (!deal) throw notFound();
  return deal;
}

/**
 * 新建商机。
 * Create a deal.
 */
export async function createDeal(ctx: AuthContext, input: z.infer<typeof dealCreateSchema>) {
  const { ownerId, custom, ...data } = input;
  requirePermission(ctx, 'record.create');
  assertFieldWrites(ctx, 'DEAL', data, null);
  assertOwnerAssignable(ctx, ownerId);
  await assertCampaign(ctx.organizationId, data.campaignId);
  await assertAccount(ctx, data.accountId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  // 阶段须为启用的选项；不填时用第一个启用的进行中阶段 / the stage must be active; defaults to the first active open stage
  if (data.stage) await assertOption(ctx.organizationId, 'DEAL_STAGE', data.stage, null, 'stage');
  else data.stage = (await firstActiveOpenStage(ctx.organizationId)) as DealStage;
  // 字段验证规则（按写入后的值）/ validation rules on the values as written
  await assertValidRecord(ctx.organizationId, 'DEAL', { ...data, ownerId: owner });
  const cf = await resolveCustom(ctx.organizationId, 'DEAL', custom, null, ctx);
  return prisma.$transaction(async (tx) => {
    await setActor(tx, ctx);
    const deal = await tx.deal.create({ data: { ...data, custom: cf.values as Prisma.InputJsonValue, organizationId: ctx.organizationId, ownerId: owner }, include });
    const customChanges = customDiff(cf.defs, null, cf.values);
    await audit(tx, { ...by(ctx), action: 'deal.create', entityType: 'deal', entityId: deal.id, changes: { after: snapshot('deal', deal), ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    await notifyAssigned(tx, ctx, { entity: 'deal', id: deal.id }, deal.name, deal.ownerId, null);
    // 工作流可能改动记录，执行后返回最新数据 / workflows may change the record; return the latest
    if (await runWorkflows(tx, { entity: 'DEAL', before: null, after: deal, actorId: ctx.userId, meta: ctx.meta })) {
      return tx.deal.findUniqueOrThrow({ where: { id: deal.id }, include });
    }
    return deal;
  });
}

/**
 * 更新商机（可改关联客户，但必须属于本组织）。
 * Update a deal (the account may change but must stay within the organization).
 */
export async function updateDeal(ctx: AuthContext, id: string, input: z.infer<typeof dealUpdateSchema>, opts: { expectedStage?: DealStage } = {}) {
  const current = await getDeal(ctx, id);
  assertCanUpdate(ctx, current);
  // 启用流程蓝图时阶段只能通过转换修改（转换会传入期望的当前阶段）/ with a blueprint the stage moves only via transitions
  if (input.stage !== undefined && input.stage !== current.stage && !opts.expectedStage) await assertNotControlled(ctx.organizationId, 'DEAL');
  const { ownerId, custom, ...data } = input;
  assertFieldWrites(ctx, 'DEAL', data, current);
  assertOwnerAssignable(ctx, ownerId);
  await assertCampaign(ctx.organizationId, data.campaignId);
  // 改为的阶段须启用（流程蓝图转换按管理员配置执行，不检查）/ a new stage must be active (blueprint transitions follow the admin's setup)
  if (!opts.expectedStage) await assertOption(ctx.organizationId, 'DEAL_STAGE', data.stage, current.stage, 'stage');
  // 有产品明细时金额由明细计算，币种需与明细一致 / with line items the amount is computed and the currency is locked
  if (data.amount !== undefined || (data.currency !== undefined && data.currency !== current.currency)) {
    const items = await prisma.dealLineItem.count({ where: { organizationId: ctx.organizationId, dealId: id } });
    if (items > 0) {
      const details: Record<string, string[]> = {};
      if (data.amount !== undefined && !current.amount.equals(data.amount)) details.amount = ['calculated_from_items'];
      if (data.currency !== undefined && data.currency !== current.currency) details.currency = ['locked_by_items'];
      if (Object.keys(details).length) throw new ApiError(409, 'CONFLICT', 'Deal has line items', details);
      delete data.amount;
    }
  }
  if (data.accountId) await assertAccount(ctx, data.accountId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  await assertValidRecord(ctx.organizationId, 'DEAL', { ...current, ...data, ownerId: owner });
  const cf = custom === undefined ? null : await resolveCustom(ctx.organizationId, 'DEAL', custom, current.custom, ctx);
  return prisma.$transaction(async (tx) => {
    await setActor(tx, ctx);
    if (opts.expectedStage) {
      // 转换：锁定记录并确认阶段未被并发修改 / transition: lock the row and make sure the stage has not changed meanwhile
      const [row] = await tx.$queryRaw<{ stage: DealStage }[]>`SELECT stage FROM deals WHERE id = ${current.id}::uuid FOR UPDATE`;
      if (row?.stage !== opts.expectedStage) throw new ApiError(409, 'CONFLICT', 'The stage changed meanwhile', { stage: ['state_changed'] });
    }
    const deal = await tx.deal.update({ where: { id: current.id }, data: { ...data, ownerId: owner, ...(cf ? { custom: cf.values as Prisma.InputJsonValue } : {}) }, include });
    await notifyAssigned(tx, ctx, { entity: 'deal', id: deal.id }, deal.name, deal.ownerId, current.ownerId);
    const fields = diff('deal', current, deal);
    const customChanges = cf ? customDiff(cf.defs, current.custom, cf.values) : {};
    if (Object.keys(fields).length || Object.keys(customChanges).length) {
      await audit(tx, { ...by(ctx), action: 'deal.update', entityType: 'deal', entityId: deal.id, changes: { fields, ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    }
    // 换客户：移除不属于新客户的联系人角色 / account changed: drop roles of contacts outside the new account
    if (deal.accountId !== current.accountId) await removeStaleRoles(tx, ctx, deal.id, deal.accountId);
    if (await runWorkflows(tx, { entity: 'DEAL', before: current, after: deal, actorId: ctx.userId, meta: ctx.meta })) {
      return tx.deal.findUniqueOrThrow({ where: { id: deal.id }, include });
    }
    return deal;
  });
}

/**
 * 删除商机：仅关联该商机的跟进随之删除，共享跟进解除关联后保留。
 * Delete a deal: deal-only activities are removed, shared ones are unlinked and kept.
 */
export async function deleteDeal(ctx: AuthContext, id: string): Promise<void> {
  assertCanDelete(ctx);
  await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findFirst({ where: { id, ...visible(ctx) } });
    if (!deal) throw notFound();
    // 订单不能删除，有订单的商机也不能删除（并发新建时 RESTRICT 外键仍会拒绝）
    // orders are never deleted, so deals with orders cannot be (the RESTRICT FK still blocks a concurrent order)
    const orders = await tx.salesOrder.count({ where: { organizationId: ctx.organizationId, dealId: id } });
    if (orders > 0) throw new ApiError(409, 'CONFLICT', 'Deal has sales orders', { salesOrders: [String(orders)] });
    // 先放入回收站（快照，含产品明细与报价单），再删除 / snapshot (items and quotes) into the recycle bin, then delete
    await recycle(tx, ctx, 'deal', id, deal.name);
    await detachSharedActivities(tx, ctx.organizationId, 'dealId', id);
    const { count } = await tx.deal.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (count === 0) throw notFound();
    await audit(tx, { ...by(ctx), action: 'deal.delete', entityType: 'deal', entityId: id, changes: { before: snapshot('deal', deal), recycled: true } });
  });
}

/** 看板查询（无分页，每列最多 limit 张卡片）/ Board query (no paging, up to `limit` cards per column) */
export const dealBoardSchema = z.object({
  q: z.string().trim().max(100).optional(),
  accountId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 看板列 / Board column */
export interface BoardColumn {
  stage: DealStage;
  count: number;
  sums: { currency: string; amount: string }[];
  items: unknown[];
  hasMore: boolean;
}

/**
 * 销售漏斗看板：按阶段分列，返回每列数量、按币种金额合计与卡片（按预计成交日期升序，无日期排后）。
 * 可见范围与列表一致（销售代表只看自己负责的）。
 * Pipeline board: one column per stage with count, per-currency totals and cards ordered by expected
 * close date (dateless last). Visibility matches the list (sales reps see their own deals only).
 */
export async function dealBoard(ctx: AuthContext, query: z.infer<typeof dealBoardSchema>): Promise<{ columns: BoardColumn[] }> {
  const where: Prisma.DealWhereInput = { AND: [readableDeals(ctx, await territoryReadScope(ctx)), { accountId: query.accountId, ownerId: query.ownerId }] };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { account: { name: c } }];
  }
  const stages = Object.values(DealStage);
  const [groups, ...cards] = await prisma.$transaction([
    prisma.deal.groupBy({
      by: ['stage', 'currency'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ stage: 'asc' }, { currency: 'asc' }],
    }),
    ...stages.map((stage) =>
      prisma.deal.findMany({
        where: { AND: [where, { stage }] },
        include,
        orderBy: [{ expectedCloseDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
      }),
    ),
  ]);
  return {
    columns: stages.map((stage, i) => {
      const rows = groups.filter((g) => g.stage === stage);
      const count = rows.reduce((n, g) => n + ((g._count as { _all: number } | undefined)?._all ?? 0), 0);
      return {
        stage,
        count,
        sums: rows.map((g) => ({ currency: g.currency, amount: (g._sum?.amount ?? 0).toString() })),
        items: cards[i] ?? [],
        hasMore: count > (cards[i]?.length ?? 0),
      };
    }),
  };
}
