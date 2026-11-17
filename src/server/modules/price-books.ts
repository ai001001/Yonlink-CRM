/**
 * 价格表（对标 Zoho Price Books）：同一产品按客户或渠道使用不同的价格。
 * - 所有用户可查看（添加商机明细时要用）；新建、修改、删除、维护产品价格、指定客户需 product.manage（管理员、经理），
 *   避免销售代表给自己的客户指定更低的价格表。
 * - 定价方式：固定价（直接使用价格表价）；阶梯价（按数量区间叠加折扣，区间不重叠，只有最后一档可以不封顶）。
 * - 价格表与商机币种一致才能使用；产品价格只能添加同币种、启用的产品。
 * - 客户可指定一个默认价格表：为该客户的商机添加产品时自动采用（产品不在表中时退回产品目录价）。
 * - 组织内名称唯一（不区分大小写）；删除价格表时清除客户上的指定；所有维护操作写审计。
 * Price books (cf. Zoho Price Books): different prices for the same product per customer or channel.
 * Everyone can read them (needed when adding deal items); create, update, delete, product prices and account assignment
 * need product.manage (admins, managers) so sales reps cannot give their own accounts a cheaper book. Pricing models:
 * FLAT (the list price as is) and DIFFERENTIAL (quantity-tier discounts; tiers never overlap and only the last tier may
 * be open-ended). A book applies only to deals in its currency; entries take active products in that currency. An
 * account may have a default book used automatically for its deals (falling back to the catalogue price for products
 * the book does not list). Names are unique per organization (case-insensitive); deleting a book clears its accounts;
 * every change is audited.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { PriceBookPricingModel } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission, visible } from '../permissions';
import { containsText, discountPercent, listQuery, optionalText, positiveQuantity, requiredText, type Page } from '../validation';
import { amountSchema, CURRENCIES } from './deals';

/** 阶梯 / Tier */
const tierSchema = z.strictObject({
  fromQuantity: positiveQuantity,
  /** 不填表示不封顶 / empty means open-ended */
  toQuantity: positiveQuantity.nullish().transform((v) => v ?? null),
  discountPercent,
});
type TierInput = z.infer<typeof tierSchema>;

const fields = {
  name: requiredText(200),
  currency: z.enum(CURRENCIES).default('CNY'),
  pricingModel: z.enum(PriceBookPricingModel).default(PriceBookPricingModel.FLAT),
  description: optionalText(2000),
  isActive: z.boolean().default(true),
  tiers: z.array(tierSchema).max(20).default([]),
};

/** 新建价格表 / Create a price book */
export const priceBookCreateSchema = z.strictObject(fields);
/** 修改价格表（提供 tiers 时整体替换）/ Update a price book (tiers, when given, replace all tiers) */
export const priceBookUpdateSchema = z
  .strictObject({ ...fields, currency: z.enum(CURRENCIES), pricingModel: z.enum(PriceBookPricingModel), isActive: z.boolean(), tiers: z.array(tierSchema).max(20) })
  .partial();
/** 列表查询 / List query */
export const priceBookListSchema = listQuery.extend({
  active: z.enum(['true', 'false']).optional(),
  currency: z.enum(CURRENCIES).optional(),
});
/** 设置产品价格 / Set a product's list price */
export const priceBookEntrySchema = z.strictObject({ productId: z.uuid(), listPrice: amountSchema });
/** 指定客户 / Assign an account */
export const priceBookAccountSchema = z.strictObject({ accountId: z.uuid() });
/** 取价查询：不传价格表时用客户默认价格表，none 表示不用价格表 / price lookup: default book when omitted, none for the catalogue */
export const priceQuerySchema = z.object({
  productId: z.uuid(),
  quantity: positiveQuantity,
  priceBookId: z.union([z.uuid(), z.literal('none')]).optional(),
});

const listInclude = { _count: { select: { entries: true, accounts: true } } } satisfies Prisma.PriceBookInclude;

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Price book name already exists', { name: ['taken'] });
  throw err;
}

/** 校验错误 / validation error */
function invalid(field: string, code: string): never {
  throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid price book', { [field]: [code] });
}

/**
 * 校验阶梯与定价方式一致：固定价不能有阶梯；阶梯价至少一档，按起始数量排序后区间不重叠，只有最后一档可以不封顶。
 * 返回排序后的阶梯。
 * Check tiers against the pricing model: FLAT has none; DIFFERENTIAL needs at least one, sorted by start, never
 * overlapping, only the last open-ended. Returns the sorted tiers.
 */
export function checkTiers(model: PriceBookPricingModel, tiers: TierInput[]): TierInput[] {
  if (model === PriceBookPricingModel.FLAT) {
    if (tiers.length) invalid('tiers', 'flat_no_tiers');
    return [];
  }
  if (!tiers.length) invalid('tiers', 'required');
  const sorted = [...tiers].sort((a, b) => new Prisma.Decimal(a.fromQuantity).cmp(b.fromQuantity));
  sorted.forEach((tier, i) => {
    const n = i + 1;
    if (tier.toQuantity !== null && new Prisma.Decimal(tier.toQuantity).lt(tier.fromQuantity)) invalid('tiers', `range:${n}`);
    const next = sorted[i + 1];
    if (!next) return;
    if (tier.toQuantity === null) invalid('tiers', `open_not_last:${n}`);
    if (new Prisma.Decimal(next.fromQuantity).lte(tier.toQuantity)) invalid('tiers', `overlap:${n}`);
  });
  return sorted;
}

/**
 * 按数量取阶梯折扣（没有匹配的区间时为 0）。
 * The tier discount for a quantity (0 when no tier matches).
 */
export function tierDiscount(tiers: { fromQuantity: Prisma.Decimal; toQuantity: Prisma.Decimal | null; discountPercent: Prisma.Decimal }[], quantity: string | Prisma.Decimal): string {
  const q = new Prisma.Decimal(quantity);
  const hit = tiers.find((t) => q.gte(t.fromQuantity) && (t.toQuantity === null || q.lte(t.toQuantity)));
  return hit ? hit.discountPercent.toFixed(2) : '0.00';
}

/**
 * 分页搜索价格表（名称、说明）。
 * Search price books (name, description), paginated.
 */
export async function listPriceBooks(ctx: AuthContext, query: z.infer<typeof priceBookListSchema>): Promise<Page<unknown>> {
  const where: Prisma.PriceBookWhereInput = {
    organizationId: ctx.organizationId,
    isActive: query.active === undefined ? undefined : query.active === 'true',
    currency: query.currency,
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { description: c }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.priceBook.findMany({ where, include: listInclude, orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.priceBook.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 价格表详情：阶梯、产品价格（含目录价便于对比）、指定的客户（只列出当前用户可见的客户）。
 * Price book detail: tiers, entries (with the catalogue price for comparison) and assigned accounts (visible ones only).
 */
export async function getPriceBook(ctx: AuthContext, id: string) {
  const book = await prisma.priceBook.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      ...listInclude,
      tiers: { orderBy: { fromQuantity: 'asc' } },
      entries: {
        include: { product: { select: { id: true, sku: true, name: true, unit: true, unitPrice: true, currency: true, isActive: true } } },
        orderBy: { product: { sku: 'asc' } },
      },
      accounts: { where: visible(ctx), select: { id: true, name: true }, orderBy: { name: 'asc' } },
    },
  });
  if (!book) throw notFound();
  return book;
}

/**
 * 读取价格表（用于维护）。
 * Load a price book for maintenance.
 */
async function requireBook(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'product.manage');
  const book = await prisma.priceBook.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { ...listInclude, tiers: { orderBy: { fromQuantity: 'asc' } } } });
  if (!book) throw notFound();
  return book;
}

/** 阶梯的审计表示 / tiers as audit text */
function tierText(tiers: { fromQuantity: Prisma.Decimal | string; toQuantity: Prisma.Decimal | string | null; discountPercent: Prisma.Decimal | string }[]): string[] {
  return tiers.map((t) => `${new Prisma.Decimal(t.fromQuantity).toString()}-${t.toQuantity === null ? '' : new Prisma.Decimal(t.toQuantity).toString()}:${new Prisma.Decimal(t.discountPercent).toString()}%`);
}

/**
 * 新建价格表。
 * Create a price book.
 */
export async function createPriceBook(ctx: AuthContext, input: z.infer<typeof priceBookCreateSchema>) {
  requirePermission(ctx, 'product.manage');
  const { tiers, ...data } = input;
  const sorted = checkTiers(input.pricingModel, tiers);
  try {
    return await prisma.$transaction(async (tx) => {
      const book = await tx.priceBook.create({ data: { ...data, organizationId: ctx.organizationId } });
      if (sorted.length) await tx.priceBookTier.createMany({ data: sorted.map((t) => ({ ...t, organizationId: ctx.organizationId, priceBookId: book.id })) });
      await audit(tx, {
        ...by(ctx),
        action: 'pricebook.create',
        entityType: 'pricebook',
        entityId: book.id,
        changes: { after: { ...snapshot('pricebook', book), ...(sorted.length ? { tiers: tierText(sorted) } : {}) } },
      });
      return book;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 修改价格表。已有产品价格时不能改币种（409）；改为固定价时清除阶梯；改为阶梯价时必须有阶梯。
 * Update a price book. The currency is fixed once it has entries (409); switching to FLAT drops the tiers; DIFFERENTIAL
 * requires tiers.
 */
export async function updatePriceBook(ctx: AuthContext, id: string, input: z.infer<typeof priceBookUpdateSchema>) {
  const current = await requireBook(ctx, id);
  const { tiers: tierInput, ...data } = input;
  if (data.currency && data.currency !== current.currency && current._count.entries > 0) {
    throw new ApiError(409, 'CONFLICT', 'Currency is fixed once products are priced', { currency: ['has_entries'] });
  }
  const model = data.pricingModel ?? current.pricingModel;
  const currentTiers = current.tiers.map((t) => ({ fromQuantity: t.fromQuantity.toString(), toQuantity: t.toQuantity?.toString() ?? null, discountPercent: t.discountPercent.toString() }));
  // 未提供阶梯时：改为固定价则清除，否则沿用现有阶梯 / without tiers: FLAT drops them, otherwise keep the current ones
  const next = tierInput ?? (model === PriceBookPricingModel.FLAT ? [] : currentTiers);
  const sorted = checkTiers(model, next);
  const before = tierText(current.tiers);
  const after = tierText(sorted);
  const tiersChanged = before.join('|') !== after.join('|');
  try {
    return await prisma.$transaction(async (tx) => {
      const book = await tx.priceBook.update({ where: { id }, data, include: listInclude });
      if (tiersChanged) {
        await tx.priceBookTier.deleteMany({ where: { priceBookId: id } });
        if (sorted.length) await tx.priceBookTier.createMany({ data: sorted.map((t) => ({ ...t, organizationId: ctx.organizationId, priceBookId: id })) });
      }
      const changes: Record<string, unknown> = diff('pricebook', current, book);
      if (tiersChanged) changes.tiers = [before, after];
      if (Object.keys(changes).length) await audit(tx, { ...by(ctx), action: 'pricebook.update', entityType: 'pricebook', entityId: id, changes: { fields: changes } });
      return book;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除价格表：同一事务内清除客户上的指定，产品价格与阶梯随之删除；已加入商机明细的价格不受影响（明细保存了当时的价格）。
 * Delete a price book: clears it from accounts in the same transaction; entries and tiers go with it. Deal items keep
 * the prices they were added with.
 */
export async function deletePriceBook(ctx: AuthContext, id: string): Promise<void> {
  const current = await requireBook(ctx, id);
  await prisma.$transaction(async (tx) => {
    const cleared = await tx.account.updateMany({ where: { organizationId: ctx.organizationId, priceBookId: id }, data: { priceBookId: null } });
    await tx.priceBook.delete({ where: { id } });
    await audit(tx, {
      ...by(ctx),
      action: 'pricebook.delete',
      entityType: 'pricebook',
      entityId: id,
      changes: { before: { ...snapshot('pricebook', current), entries: current._count.entries, accounts: cleared.count } },
    });
  });
}

/**
 * 设置产品价格（新增或修改）：产品须属于本组织、已启用、币种与价格表一致。
 * Set a product's list price (add or change): the product must be in the organization, active and in the book's currency.
 */
export async function setEntry(ctx: AuthContext, id: string, input: z.infer<typeof priceBookEntrySchema>) {
  const book = await requireBook(ctx, id);
  const product = await prisma.product.findFirst({ where: { id: input.productId, organizationId: ctx.organizationId } });
  if (!product) invalid('productId', 'not_found');
  if (!product.isActive) invalid('productId', 'inactive');
  if (product.currency !== book.currency) invalid('productId', 'currency_mismatch');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.priceBookEntry.findUnique({ where: { priceBookId_productId: { priceBookId: id, productId: product.id } } });
    const entry = await tx.priceBookEntry.upsert({
      where: { priceBookId_productId: { priceBookId: id, productId: product.id } },
      create: { organizationId: ctx.organizationId, priceBookId: id, productId: product.id, listPrice: input.listPrice },
      update: { listPrice: input.listPrice },
    });
    if (!existing || !existing.listPrice.equals(entry.listPrice)) {
      await audit(tx, {
        ...by(ctx),
        action: 'pricebook.set_price',
        entityType: 'pricebook',
        entityId: id,
        changes: { sku: product.sku, listPrice: [existing?.listPrice.toString() ?? null, entry.listPrice.toString()] },
      });
    }
    return entry;
  });
}

/**
 * 移除产品价格。
 * Remove a product's list price.
 */
export async function removeEntry(ctx: AuthContext, id: string, productId: string): Promise<void> {
  await requireBook(ctx, id);
  const entry = await prisma.priceBookEntry.findUnique({ where: { priceBookId_productId: { priceBookId: id, productId } }, include: { product: { select: { sku: true } } } });
  if (!entry) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.priceBookEntry.delete({ where: { id: entry.id } });
    await audit(tx, { ...by(ctx), action: 'pricebook.remove_price', entityType: 'pricebook', entityId: id, changes: { sku: entry.product.sku, listPrice: entry.listPrice.toString() } });
  });
}

/**
 * 指定为客户的默认价格表（替换客户原有的价格表）；停用的价格表不能指定。
 * Make the book an account's default (replacing any previous one); inactive books cannot be assigned.
 */
export async function assignAccount(ctx: AuthContext, id: string, accountId: string) {
  const book = await requireBook(ctx, id);
  if (!book.isActive) invalid('priceBookId', 'inactive');
  const account = await prisma.account.findFirst({ where: { id: accountId, ...visible(ctx) }, include: { priceBook: { select: { id: true, name: true } } } });
  if (!account) invalid('accountId', 'not_found');
  if (account.priceBookId === id) return { id: account.id, name: account.name };
  await prisma.$transaction(async (tx) => {
    await tx.account.update({ where: { id: account.id }, data: { priceBookId: id } });
    await audit(tx, {
      ...by(ctx),
      action: 'pricebook.assign',
      entityType: 'pricebook',
      entityId: id,
      changes: { account: account.name, ...(account.priceBook ? { replaced: account.priceBook.name } : {}) },
    });
  });
  return { id: account.id, name: account.name };
}

/**
 * 取消客户的默认价格表。
 * Remove the book as an account's default.
 */
export async function unassignAccount(ctx: AuthContext, id: string, accountId: string): Promise<void> {
  await requireBook(ctx, id);
  const account = await prisma.account.findFirst({ where: { id: accountId, ...visible(ctx), priceBookId: id } });
  if (!account) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.account.update({ where: { id: account.id }, data: { priceBookId: null } });
    await audit(tx, { ...by(ctx), action: 'pricebook.unassign', entityType: 'pricebook', entityId: id, changes: { account: account.name } });
  });
}

/** 取价结果 / Price lookup result */
export interface PriceQuote {
  unitPrice: string;
  discountPercent: string;
  /** 价格来源价格表；为空时取产品目录价 / source book; null for the catalogue price */
  priceBook: { id: string; name: string } | null;
}

/**
 * 为商机明细取价。
 * - 指定价格表（priceBookId）：必须存在、启用、币种与商机一致、包含该产品，否则 400。
 * - 未指定（undefined）：使用商机客户的默认价格表；未指定、已停用、币种不同或不含该产品时取产品目录价。
 * - null：直接取产品目录价。
 * 阶梯价按数量取折扣；固定价折扣为 0。
 * Price a deal line item. An explicit book must exist, be active, match the deal currency and list the product (400
 * otherwise); undefined uses the deal account's default book, falling back to the catalogue price when there is none or
 * it is inactive, in another currency or does not list the product; null means the catalogue price. DIFFERENTIAL books
 * add the tier discount for the quantity; FLAT books have none.
 */
export async function priceFor(
  ctx: AuthContext,
  deal: { currency: string; accountId: string },
  product: { id: string; unitPrice: Prisma.Decimal },
  quantity: string,
  priceBookId: string | null | undefined,
): Promise<PriceQuote> {
  const catalogue: PriceQuote = { unitPrice: product.unitPrice.toFixed(2), discountPercent: '0.00', priceBook: null };
  if (priceBookId === null) return catalogue;
  const include = { tiers: true, entries: { where: { productId: product.id } } } satisfies Prisma.PriceBookInclude;
  let book;
  if (priceBookId) {
    book = await prisma.priceBook.findFirst({ where: { id: priceBookId, organizationId: ctx.organizationId }, include });
    if (!book) invalid('priceBookId', 'not_found');
    if (!book.isActive) invalid('priceBookId', 'inactive');
    if (book.currency !== deal.currency) invalid('priceBookId', 'currency_mismatch');
  } else {
    book = await prisma.priceBook.findFirst({ where: { organizationId: ctx.organizationId, isActive: true, currency: deal.currency, accounts: { some: { id: deal.accountId } } }, include });
    if (!book) return catalogue;
  }
  const entry = book.entries[0];
  if (!entry) {
    if (priceBookId) invalid('priceBookId', 'product_not_listed');
    return catalogue;
  }
  const discount = book.pricingModel === PriceBookPricingModel.DIFFERENTIAL ? tierDiscount(book.tiers, quantity) : '0.00';
  return { unitPrice: entry.listPrice.toFixed(2), discountPercent: discount, priceBook: { id: book.id, name: book.name } };
}
