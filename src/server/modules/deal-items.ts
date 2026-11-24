/**
 * 商机产品明细应用服务。
 * - 小计 = 数量 × 单价 × (1 − 折扣%/100)，十进制计算，四舍五入到分。
 * - 有明细时商机金额 = 明细合计；增删改明细在同一事务内重算商机金额并写审计。
 * - 明细币种必须与商机币种一致；停用的产品不能新增到商机。
 * - 需能编辑所属商机。
 * - 新增明细时按价格表取价（见 price-books.priceFor）：未填单价、折扣时使用价格表价与阶梯折扣，并保存价格表名称快照。
 * Deal line items: line total = qty × price × (1 − discount%), decimal maths rounded half-up to cents;
 * the deal amount equals the sum of its items and is recalculated in the same transaction; item currency
 * must match the deal; inactive products cannot be added; requires edit rights on the deal. New items are priced from
 * price books (see price-books.priceFor): without an explicit price or discount the list price and tier discount are
 * used and the book name is kept as a snapshot.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { audit, by, setActor } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, visible } from '../permissions';
import { readableDeals, territoryReadScope } from './territory-rules';
import { discountPercent as discount, positiveQuantity as quantity } from '../validation';
import { amountSchema } from './deals';
import { priceFor, type priceQuerySchema } from './price-books';

/** 新增明细 / Add a line item */
export const itemCreateSchema = z.strictObject({
  productId: z.uuid(),
  quantity,
  /** 不填时按价格表或产品目录价 / defaults to the price book or catalogue price */
  unitPrice: amountSchema.optional(),
  /** 不填时按价格表阶梯折扣，否则为 0 / defaults to the tier discount, else 0 */
  discountPercent: discount.optional(),
  /** 不填时用客户默认价格表；null 表示不用价格表 / default: the account's book; null: no price book */
  priceBookId: z.uuid().nullable().optional(),
});
/** 修改明细 / Update a line item */
export const itemUpdateSchema = z.strictObject({ quantity, unitPrice: amountSchema, discountPercent: discount }).partial();

/**
 * 计算小计（四舍五入到分）。
 * Compute a line total rounded half-up to cents.
 */
export function lineTotal(qty: string | Prisma.Decimal, price: string | Prisma.Decimal, discountPercent: string | Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(qty)
    .mul(price)
    .mul(new Prisma.Decimal(100).minus(discountPercent))
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * 读取可见商机（含负责人与币种）。
 * Load a visible deal (owner and currency).
 */
async function requireDeal(ctx: AuthContext, dealId: string) {
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id: dealId }, readableDeals(ctx, await territoryReadScope(ctx))] }, select: { id: true, ownerId: true, currency: true, amount: true, accountId: true } });
  if (!deal) throw notFound();
  return deal;
}

/**
 * 在事务内重算商机金额并在变化时写审计。
 * Recalculate the deal amount inside the transaction and audit the change.
 */
async function recalc(tx: Prisma.TransactionClient, ctx: AuthContext, dealId: string, before: Prisma.Decimal) {
  const sum = await tx.dealLineItem.aggregate({ where: { organizationId: ctx.organizationId, dealId }, _sum: { lineTotal: true } });
  const amount = sum._sum.lineTotal ?? new Prisma.Decimal(0);
  if (!amount.equals(before)) {
    await setActor(tx, ctx);
    await tx.deal.update({ where: { id: dealId }, data: { amount } });
    await audit(tx, { ...by(ctx), action: 'deal.update', entityType: 'deal', entityId: dealId, changes: { fields: { amount: [before.toString(), amount.toString()] }, via: 'deal.items' } });
  }
  return amount;
}

/**
 * 商机的产品明细与合计。
 * Line items of a deal with the total.
 */
export async function listItems(ctx: AuthContext, dealId: string) {
  const deal = await requireDeal(ctx, dealId);
  const items = await prisma.dealLineItem.findMany({
    where: { organizationId: ctx.organizationId, dealId },
    include: { product: { select: { unit: true, isActive: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const total = items.reduce((s, i) => s.plus(i.lineTotal), new Prisma.Decimal(0));
  return { items, total: total.toFixed(2), currency: deal.currency };
}

/**
 * 新增明细。
 * Add a line item.
 */
export async function addItem(ctx: AuthContext, dealId: string, input: z.infer<typeof itemCreateSchema>) {
  const deal = await requireDeal(ctx, dealId);
  assertCanUpdate(ctx, deal);
  const product = await prisma.product.findFirst({ where: { id: input.productId, organizationId: ctx.organizationId } });
  if (!product) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid product', { productId: ['not_found'] });
  if (!product.isActive) throw new ApiError(400, 'VALIDATION_ERROR', 'Product is inactive', { productId: ['inactive'] });
  if (product.currency !== deal.currency) throw new ApiError(400, 'VALIDATION_ERROR', 'Currency mismatch', { productId: ['currency_mismatch'] });
  const priced = await priceFor(ctx, deal, product, input.quantity, input.priceBookId);
  const unitPrice = input.unitPrice ?? priced.unitPrice;
  const discountPercent = input.discountPercent ?? priced.discountPercent;
  // 手工填写单价时不算价格表价 / a manual price does not come from the book
  const priceBookName = input.unitPrice === undefined ? (priced.priceBook?.name ?? null) : null;
  return prisma.$transaction(async (tx) => {
    const item = await tx.dealLineItem.create({
      data: {
        organizationId: ctx.organizationId,
        dealId,
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        quantity: input.quantity,
        unitPrice,
        discountPercent,
        lineTotal: lineTotal(input.quantity, unitPrice, discountPercent),
        priceBookName,
      },
    });
    await audit(tx, {
      ...by(ctx),
      action: 'deal.add_item',
      entityType: 'deal',
      entityId: dealId,
      changes: { sku: item.productSku, quantity: item.quantity.toString(), unitPrice: item.unitPrice.toString(), discountPercent: item.discountPercent.toString(), lineTotal: item.lineTotal.toString(), ...(priceBookName ? { priceBook: priceBookName } : {}) },
    });
    const amount = await recalc(tx, ctx, dealId, deal.amount);
    return { item, dealAmount: amount.toFixed(2) };
  });
}

/**
 * 预览新增明细时的取价（与新增明细使用同一规则），供界面在添加前显示价格来源。
 * Preview the price a new item would get (same rules as adding), so the UI can show the source before adding.
 */
export async function previewPrice(ctx: AuthContext, dealId: string, query: z.infer<typeof priceQuerySchema>) {
  const deal = await requireDeal(ctx, dealId);
  const product = await prisma.product.findFirst({ where: { id: query.productId, organizationId: ctx.organizationId } });
  if (!product) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid product', { productId: ['not_found'] });
  const priced = await priceFor(ctx, deal, product, query.quantity, query.priceBookId === 'none' ? null : query.priceBookId);
  return { ...priced, lineTotal: lineTotal(query.quantity, priced.unitPrice, priced.discountPercent).toFixed(2), currency: deal.currency };
}

/**
 * 读取明细（所属商机必须可见）。
 * Load a line item whose deal is visible.
 */
async function requireItem(ctx: AuthContext, id: string) {
  const item = await prisma.dealLineItem.findFirst({
    where: { id, organizationId: ctx.organizationId, deal: visible(ctx) },
    include: { deal: { select: { id: true, ownerId: true, amount: true } } },
  });
  if (!item) throw notFound();
  return item;
}

/**
 * 修改明细（数量、单价、折扣），重算小计与商机金额。
 * Update a line item and recalculate its total and the deal amount.
 */
export async function updateItem(ctx: AuthContext, id: string, input: z.infer<typeof itemUpdateSchema>) {
  const current = await requireItem(ctx, id);
  assertCanUpdate(ctx, current.deal);
  const qty = input.quantity ?? current.quantity.toString();
  const price = input.unitPrice ?? current.unitPrice.toString();
  const disc = input.discountPercent ?? current.discountPercent.toString();
  return prisma.$transaction(async (tx) => {
    const item = await tx.dealLineItem.update({ where: { id }, data: { quantity: qty, unitPrice: price, discountPercent: disc, lineTotal: lineTotal(qty, price, disc) } });
    const fields: Record<string, [string, string]> = {};
    for (const k of ['quantity', 'unitPrice', 'discountPercent', 'lineTotal'] as const) {
      if (!current[k].equals(item[k])) fields[k] = [current[k].toString(), item[k].toString()];
    }
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'deal.update_item', entityType: 'deal', entityId: current.dealId, changes: { sku: item.productSku, fields } });
    }
    const amount = await recalc(tx, ctx, current.dealId, current.deal.amount);
    return { item, dealAmount: amount.toFixed(2) };
  });
}

/**
 * 删除明细并重算商机金额。
 * Remove a line item and recalculate the deal amount.
 */
export async function removeItem(ctx: AuthContext, id: string) {
  const current = await requireItem(ctx, id);
  assertCanUpdate(ctx, current.deal);
  return prisma.$transaction(async (tx) => {
    await tx.dealLineItem.delete({ where: { id } });
    await audit(tx, {
      ...by(ctx),
      action: 'deal.remove_item',
      entityType: 'deal',
      entityId: current.dealId,
      changes: { sku: current.productSku, quantity: current.quantity.toString(), lineTotal: current.lineTotal.toString() },
    });
    const amount = await recalc(tx, ctx, current.dealId, current.deal.amount);
    return { dealAmount: amount.toFixed(2) };
  });
}
