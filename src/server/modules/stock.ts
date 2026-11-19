/**
 * 产品库存（对标 Zoho Inventory 的库存数量与再订货水平）。
 * - 库存只通过流水改变：手工调整（增减或盘点为指定数量，需 product.manage，须填写原因）、采购收货（增加）、
 *   销售订单发货（减少）、已发货订单取消（按原发货数量退回）。流水写入时由数据库触发器原子更新产品库存并记录余额。
 * - 单据明细按 SKU 对应产品（含已停用产品）；找不到产品的明细不影响库存。允许库存为负（发货不被库存阻挡），界面以红色提示。
 * - 低库存：设置了再订货水平且库存不高于它；列表可筛选低库存与缺货（≤ 0），并汇总数量。
 * - 所有用户可查看库存与流水；采购单号只对有 purchase.read 的用户显示。
 * Product stock (cf. Zoho Inventory quantity in stock and reorder level). Stock changes only through movements: manual
 * adjustments (add/subtract or count to a quantity; product.manage; a reason is required), purchase receipts (in),
 * sales-order shipments (out) and cancellations of shipped orders (the shipped quantities return). A database trigger
 * applies each movement atomically and records the balance. Lines map to products by SKU (inactive included); lines
 * without a product do not touch stock. Negative stock is allowed (shipping is never blocked) and highlighted. Low stock
 * means a reorder level is set and stock is at or below it; lists filter low and out-of-stock (≤ 0) with counts.
 * Everyone can view stock and movements; purchase-order numbers show only with purchase.read.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { StockReason } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { can, requirePermission } from '../permissions';
import { requiredText } from '../validation';

/** 数量：最多 16 位整数、2 位小数 / quantity: ≤ 16 integer and 2 decimal digits */
const quantity = (signed: boolean) =>
  z
    .union([z.string().trim(), z.number().finite()])
    .transform((v) => String(v))
    .pipe(z.string().regex(signed ? /^-?\d{1,16}(\.\d{1,2})?$/ : /^\d{1,16}(\.\d{1,2})?$/, 'Invalid quantity'));

/** 手工调整：add 为增减数量（非 0），set 为盘点后的数量 / adjustment: add a signed delta, or set the counted quantity */
export const stockAdjustSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('add'), quantity: quantity(true).refine((v) => Number(v) !== 0, 'zero'), note: requiredText(200) }),
  z.strictObject({ mode: z.literal('set'), quantity: quantity(false), note: requiredText(200) }),
]);
/** 流水查询 / movement query */
export const stockMovementQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * 手工调整库存（行锁内计算盘点差额；差额为 0 返回 409）。
 * Adjust stock manually (the count delta is computed under the row lock; a zero delta → 409).
 */
export async function adjustStock(ctx: AuthContext, productId: string, input: z.infer<typeof stockAdjustSchema>) {
  requirePermission(ctx, 'product.manage');
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ sku: string; stock_quantity: Prisma.Decimal }[]>`
      SELECT sku, stock_quantity FROM products WHERE id = ${productId}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
    if (!row) throw notFound();
    const current = new Prisma.Decimal(row.stock_quantity);
    const delta = input.mode === 'add' ? new Prisma.Decimal(input.quantity) : new Prisma.Decimal(input.quantity).minus(current);
    if (delta.isZero()) throw new ApiError(409, 'CONFLICT', 'Stock unchanged', { quantity: ['no_change'] });
    const m = await tx.stockMovement.create({
      data: { organizationId: ctx.organizationId, productId, reason: StockReason.ADJUSTMENT, quantity: delta, note: input.note, actorId: ctx.userId },
    });
    await audit(tx, {
      ...by(ctx),
      action: 'product.stock_adjust',
      entityType: 'product',
      entityId: productId,
      changes: { sku: row.sku, mode: input.mode, quantity: delta.toString(), stock: [current.toString(), m.balanceAfter.toString()] },
    });
    return { quantity: m.quantity.toString(), balanceAfter: m.balanceAfter.toString() };
  });
}

/**
 * 单据明细按 SKU 写入库存流水（在业务事务内调用；找不到产品的明细跳过）。
 * Write movements for document lines by SKU (inside the business transaction; lines without a product are skipped).
 * @returns 写入的流水（SKU、数量、余额）/ written movements (SKU, quantity, balance)
 */
export async function recordMovements(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  reason: StockReason,
  lines: { sku: string; quantity: Prisma.Decimal | string }[],
  ref: { purchaseOrderId?: string; salesOrderId?: string },
): Promise<{ sku: string; quantity: string; balance: string }[]> {
  const skus = [...new Set(lines.map((l) => l.sku.toUpperCase()))];
  const products = await tx.product.findMany({ where: { organizationId: ctx.organizationId, sku: { in: skus } }, select: { id: true, sku: true } });
  const bySku = new Map(products.map((p) => [p.sku, p.id]));
  const out = reason === StockReason.SALES_SHIPMENT;
  const written: { sku: string; quantity: string; balance: string }[] = [];
  for (const l of lines) {
    const productId = bySku.get(l.sku.toUpperCase());
    const q = new Prisma.Decimal(l.quantity);
    if (!productId || q.isZero()) continue;
    const m = await tx.stockMovement.create({
      data: { organizationId: ctx.organizationId, productId, reason, quantity: out ? q.negated() : q, actorId: ctx.userId, ...ref },
    });
    written.push({ sku: l.sku, quantity: m.quantity.toString(), balance: m.balanceAfter.toString() });
  }
  return written;
}

/**
 * 已发货订单取消：按该订单的发货流水退回库存（只退一次）。
 * Return stock for a cancelled shipped order using its shipment movements (once).
 */
export async function returnShipment(tx: Prisma.TransactionClient, ctx: AuthContext, salesOrderId: string) {
  const shipped = await tx.stockMovement.findMany({ where: { organizationId: ctx.organizationId, salesOrderId, reason: StockReason.SALES_SHIPMENT }, include: { product: { select: { sku: true } } } });
  if (await tx.stockMovement.count({ where: { organizationId: ctx.organizationId, salesOrderId, reason: StockReason.SALES_RETURN } })) return [];
  const written: { sku: string; quantity: string; balance: string }[] = [];
  for (const s of shipped) {
    const m = await tx.stockMovement.create({
      data: { organizationId: ctx.organizationId, productId: s.productId, reason: StockReason.SALES_RETURN, quantity: s.quantity.negated(), actorId: ctx.userId, salesOrderId },
    });
    written.push({ sku: s.product.sku, quantity: m.quantity.toString(), balance: m.balanceAfter.toString() });
  }
  return written;
}

/**
 * 产品的库存流水（最新在前）。
 * A product's stock movements, newest first.
 */
export async function listMovements(ctx: AuthContext, productId: string, query: z.infer<typeof stockMovementQuerySchema>) {
  const product = await prisma.product.findFirst({ where: { id: productId, organizationId: ctx.organizationId }, select: { id: true, sku: true, stockQuantity: true, reorderLevel: true, unit: true } });
  if (!product) throw notFound();
  const where = { organizationId: ctx.organizationId, productId };
  const [rows, total] = await prisma.$transaction([
    prisma.stockMovement.findMany({
      where,
      select: {
        id: true,
        reason: true,
        quantity: true,
        balanceAfter: true,
        note: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, poNumber: true } },
        salesOrder: { select: { id: true, orderNumber: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.stockMovement.count({ where }),
  ]);
  // 没有采购查看权限时不显示采购单 / hide purchase orders without purchase.read
  const items = can(ctx, 'purchase.read') ? rows : rows.map((r) => ({ ...r, purchaseOrder: null }));
  return { product, items, total, page: query.page, pageSize: query.pageSize };
}

/** 低库存条件 / low-stock condition */
export const lowStockWhere = (): Prisma.ProductWhereInput => ({ reorderLevel: { not: null }, stockQuantity: { lte: prisma.product.fields.reorderLevel } });

/**
 * 库存汇总：启用产品中的低库存与缺货数量。
 * Stock summary: low and out-of-stock counts among active products.
 */
export async function stockSummary(ctx: AuthContext) {
  const base = { organizationId: ctx.organizationId, isActive: true };
  const [low, out] = await Promise.all([prisma.product.count({ where: { ...base, ...lowStockWhere() } }), prisma.product.count({ where: { ...base, stockQuantity: { lte: 0 } } })]);
  return { low, out };
}
