/**
 * 商机应用服务。金额以十进制字符串传输，数据库为 numeric(18,2)。
 * Deals application service. Amounts travel as decimal strings; stored as numeric(18,2).
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { DealStage } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, requirePermission, visible } from '../permissions';
import { ApiError, notFound } from '../errors';
import { detachSharedActivities } from './activities';
import { containsText, listQuery, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';

/** 支持的币种 / Supported currencies */
export const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'] as const;

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
  stage: z.enum(DealStage).default(DealStage.QUALIFICATION),
  expectedCloseDate: dateOnly
    .nullish()
    .transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null)),
  description: optionalText(5000),
  ownerId: optionalUuid.optional(),
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
});

const include = {
  owner: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
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
 * 分页搜索商机（名称、客户名称），并返回筛选结果按币种的金额合计。
 * Search deals (name, account name) and return per-currency totals for the filter.
 */
export async function listDeals(
  ctx: AuthContext,
  query: z.infer<typeof dealListSchema>,
): Promise<Page<unknown> & { sums: { currency: string; amount: string }[] }> {
  const where: Prisma.DealWhereInput = { AND: [visible(ctx), { stage: query.stage, accountId: query.accountId, ownerId: query.ownerId }] };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { account: { name: c } }];
  }
  const [items, total, sums] = await prisma.$transaction([
    prisma.deal.findMany({
      where,
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
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
  const deal = await prisma.deal.findFirst({ where: { id, ...visible(ctx) }, include });
  if (!deal) throw notFound();
  return deal;
}

/**
 * 新建商机。
 * Create a deal.
 */
export async function createDeal(ctx: AuthContext, input: z.infer<typeof dealCreateSchema>) {
  const { ownerId, ...data } = input;
  requirePermission(ctx, 'record.create');
  assertOwnerAssignable(ctx, ownerId);
  await assertAccount(ctx, data.accountId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  return prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({ data: { ...data, organizationId: ctx.organizationId, ownerId: owner }, include });
    await audit(tx, { ...by(ctx), action: 'deal.create', entityType: 'deal', entityId: deal.id, changes: { after: snapshot('deal', deal) } });
    return deal;
  });
}

/**
 * 更新商机（可改关联客户，但必须属于本组织）。
 * Update a deal (the account may change but must stay within the organization).
 */
export async function updateDeal(ctx: AuthContext, id: string, input: z.infer<typeof dealUpdateSchema>) {
  const current = await getDeal(ctx, id);
  assertCanUpdate(ctx, current);
  const { ownerId, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  if (data.accountId) await assertAccount(ctx, data.accountId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  return prisma.$transaction(async (tx) => {
    const deal = await tx.deal.update({ where: { id: current.id }, data: { ...data, ownerId: owner }, include });
    const fields = diff('deal', current, deal);
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'deal.update', entityType: 'deal', entityId: deal.id, changes: { fields } });
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
    await detachSharedActivities(tx, ctx.organizationId, 'dealId', id);
    const { count } = await tx.deal.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (count === 0) throw notFound();
    await audit(tx, { ...by(ctx), action: 'deal.delete', entityType: 'deal', entityId: id, changes: { before: snapshot('deal', deal) } });
  });
}
