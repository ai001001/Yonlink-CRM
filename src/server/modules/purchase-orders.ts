/**
 * 采购单（对标 Zoho Purchase Orders）。
 * - 查看需 purchase.read（管理员、经理、只读用户）；新建、修改、状态变更、收货、删除需 purchase.manage（管理员、经理）。
 * - 编号 PO-年份-序号，由计数器原子分配，删除的编号不复用。
 * - 草稿：可改供应商、币种、税率与明细（整体替换）；明细可选产品目录（产品信息快照）或手工填写 SKU、名称、单位。
 *   可关联一张销售订单（以销定采），未给明细时复制该订单明细（采购单价需填写后才能下单）。
 * - 状态：草稿 → 已下单 → 部分到货 → 已到货；草稿、已下单（尚未收货）可取消；已到货、已取消为终态。
 *   下单时要求每行采购单价大于 0，锁定明细，并保存下单日汇率快照与折合人民币金额（缺汇率时为空）。
 * - 收货：按行登记本次收货数量，累计不超过采购数量；全部收齐为已到货，否则为部分到货。行锁防止并发超收。
 * - 只能删除草稿；有采购单的供应商不能删除。修改带乐观并发。新建、修改、状态变更、收货、删除写审计。
 * Purchase orders (cf. Zoho Purchase Orders). Viewing needs purchase.read; everything else purchase.manage.
 * PO-year-sequence numbers come from an atomic counter and are never reused. Drafts may change vendor, currency, tax
 * and lines (replaced as a whole); lines come from the catalogue (snapshotted) or are typed in; a draft may reference a
 * sales order and copies its lines when none are given (costs must be filled in before ordering). DRAFT → ORDERED →
 * PARTIALLY_RECEIVED → RECEIVED; drafts and orders with nothing received can be cancelled. Ordering requires positive
 * costs, locks the lines and snapshots the order-day rate and CNY total (null when the rate is missing). Receiving
 * records per-line quantities up to the ordered amount under a row lock. Only drafts can be deleted. Updates use
 * optimistic concurrency and everything is audited.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { PurchaseOrderStatus } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { containsText, listQuery, optionalText, requiredText, type Page } from '../validation';
import { amountSchema, CURRENCIES, dateOnly } from './deals';
import { ratesOn, toBase } from './exchange-rates';

const DONE: PurchaseOrderStatus[] = [PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED];

/** 数量：大于 0，最多两位小数 / quantity: positive, up to 2 decimals */
const quantity = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Invalid quantity'))
  .refine((v) => Number(v) > 0, 'Quantity must be positive');
/** 税率 0–100 / tax 0–100 */
const taxPercent = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Invalid tax'))
  .refine((v) => Number(v) <= 100, 'Tax must be at most 100');
const date = dateOnly.nullish().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null));

/** 明细：产品目录或手工填写 / line: from the catalogue or typed in */
const lineSchema = z
  .strictObject({
    productId: z.uuid().optional(),
    productSku: z.string().trim().min(1).max(50).optional(),
    productName: z.string().trim().min(1).max(200).optional(),
    unit: z.string().trim().min(1).max(20).optional(),
    quantity,
    unitCost: amountSchema,
  })
  .refine((l) => l.productId || (l.productSku && l.productName && l.unit), { message: 'productId or sku, name and unit required', path: ['productId'] });

/** 新建采购单 / Create a purchase order */
export const poCreateSchema = z.strictObject({
  vendorId: z.uuid(),
  salesOrderId: z.uuid().optional(),
  subject: requiredText(200),
  /** 不填时使用供应商默认币种 / defaults to the vendor currency */
  currency: z.enum(CURRENCIES).optional(),
  taxPercent: taxPercent.default('0'),
  expectedDate: date,
  /** 不填时使用关联销售订单的收货地址 / defaults to the sales order's shipping address */
  deliveryAddress: optionalText(500).optional(),
  notes: optionalText(5000),
  /** 不填时从关联销售订单复制 / copied from the sales order when omitted */
  lines: z.array(lineSchema).min(1).max(200).optional(),
});
/** 修改采购单（明细等只在草稿可改）/ Update a purchase order (lines etc. only in a draft) */
export const poUpdateSchema = z
  .strictObject({
    vendorId: z.uuid(),
    subject: requiredText(200),
    currency: z.enum(CURRENCIES),
    taxPercent,
    expectedDate: date,
    deliveryAddress: optionalText(500),
    notes: optionalText(5000),
    lines: z.array(lineSchema).min(1).max(200),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'No changes');
/** 状态变更 / Status change */
export const poStatusSchema = z
  .strictObject({ status: z.enum([PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.CANCELLED]), reason: optionalText(500) })
  .refine((v) => v.status === PurchaseOrderStatus.CANCELLED || !v.reason, { path: ['reason'], message: 'Only for cancellation' });
/** 收货 / Receive goods */
export const poReceiveSchema = z.strictObject({
  lines: z.array(z.strictObject({ lineId: z.uuid(), quantity })).min(1).max(200),
});
/** 列表查询 / List query */
export const poListSchema = listQuery.extend({
  status: z.enum(PurchaseOrderStatus).optional(),
  vendorId: z.uuid().optional(),
  salesOrderId: z.uuid().optional(),
});

const listInclude = {
  vendor: { select: { id: true, name: true } },
  salesOrder: { select: { id: true, orderNumber: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.PurchaseOrderInclude;
const detailInclude = {
  ...listInclude,
  vendor: { select: { id: true, name: true, contactName: true, phone: true, email: true, address: true, paymentTerms: true } },
  organization: { select: { name: true } },
  lines: { orderBy: { position: 'asc' } },
} satisfies Prisma.PurchaseOrderInclude;

type LineInput = z.infer<typeof lineSchema>;
type LineData = { productSku: string; productName: string; unit: string; quantity: string; unitCost: string; lineTotal: Prisma.Decimal };

/**
 * 原子分配下一个采购单号。
 * Allocate the next purchase order number atomically.
 */
async function nextNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO document_counters (organization_id, kind, year, last) VALUES (${organizationId}::uuid, 'PO', ${year}, 1)
    ON CONFLICT (organization_id, kind, year) DO UPDATE SET last = document_counters.last + 1
    RETURNING last`;
  return `PO-${year}-${String(rows[0]!.last).padStart(4, '0')}`;
}

/**
 * 解析明细：产品目录的取快照，手工填写的原样使用；计算小计。
 * Resolve lines: snapshot catalogue products, keep typed-in ones; compute line totals.
 */
async function resolveLines(ctx: AuthContext, lines: LineInput[]): Promise<LineData[]> {
  const ids = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const products = ids.length ? await prisma.product.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, sku: true, name: true, unit: true } }) : [];
  return lines.map((l, i) => {
    const p = l.productId ? products.find((x) => x.id === l.productId) : null;
    if (l.productId && !p) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid product', { [`lines.${i}.productId`]: ['not_found'] });
    const lineTotal = new Prisma.Decimal(l.quantity).mul(l.unitCost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    return { productSku: p?.sku ?? l.productSku!, productName: p?.name ?? l.productName!, unit: p?.unit ?? l.unit!, quantity: l.quantity, unitCost: l.unitCost, lineTotal };
  });
}

/**
 * 合计：小计、税额（四舍五入到分）、总额。
 * Totals: subtotal, tax (rounded to cents) and total.
 */
function totals(lines: { lineTotal: Prisma.Decimal | string }[], tax: string | Prisma.Decimal) {
  const subtotal = lines.reduce((s, l) => s.plus(l.lineTotal), new Prisma.Decimal(0));
  const taxAmount = subtotal.mul(tax).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { subtotal, taxAmount, total: subtotal.plus(taxAmount) };
}

/**
 * 校验供应商（存在且启用）。
 * Check the vendor exists and is active.
 */
async function requireVendor(ctx: AuthContext, vendorId: string) {
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, organizationId: ctx.organizationId }, select: { id: true, isActive: true, currency: true } });
  if (!vendor) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid vendor', { vendorId: ['not_found'] });
  if (!vendor.isActive) throw new ApiError(400, 'VALIDATION_ERROR', 'Vendor is inactive', { vendorId: ['inactive'] });
  return vendor;
}

/**
 * 分页搜索采购单（单号、主题、供应商、关联销售订单号）。
 * Search purchase orders (number, subject, vendor, sales order number), paginated.
 */
export async function listPurchaseOrders(ctx: AuthContext, query: z.infer<typeof poListSchema>): Promise<Page<unknown>> {
  requirePermission(ctx, 'purchase.read');
  const where: Prisma.PurchaseOrderWhereInput = { organizationId: ctx.organizationId, status: query.status, vendorId: query.vendorId, salesOrderId: query.salesOrderId };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ poNumber: c }, { subject: c }, { vendor: { name: c } }, { salesOrder: { orderNumber: c } }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.purchaseOrder.findMany({ where, include: listInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 采购单详情（含明细、供应商联系方式）。
 * Purchase order detail with lines and vendor contact.
 */
export async function getPurchaseOrder(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'purchase.read');
  const po = await prisma.purchaseOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: detailInclude });
  if (!po) throw notFound();
  return po;
}

/**
 * 新建采购单（草稿）。给了销售订单但没给明细时复制订单明细，采购单价为 0 待填写。
 * Create a draft purchase order; with a sales order and no lines, its lines are copied with zero costs to fill in.
 */
export async function createPurchaseOrder(ctx: AuthContext, input: z.infer<typeof poCreateSchema>) {
  requirePermission(ctx, 'purchase.manage');
  const vendor = await requireVendor(ctx, input.vendorId);
  let lines: LineData[];
  let deliveryAddress = input.deliveryAddress;
  if (input.salesOrderId) {
    const so = await prisma.salesOrder.findFirst({ where: { id: input.salesOrderId, organizationId: ctx.organizationId }, include: { lines: { orderBy: { position: 'asc' } } } });
    if (!so) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid sales order', { salesOrderId: ['not_found'] });
    if (so.status === 'CANCELLED') throw new ApiError(400, 'VALIDATION_ERROR', 'Sales order is cancelled', { salesOrderId: ['cancelled'] });
    deliveryAddress = deliveryAddress === undefined ? so.shippingAddress : deliveryAddress;
    lines = input.lines
      ? await resolveLines(ctx, input.lines)
      : so.lines.map((l) => ({ productSku: l.productSku, productName: l.productName, unit: l.unit, quantity: l.quantity.toString(), unitCost: '0', lineTotal: new Prisma.Decimal(0) }));
  } else {
    if (!input.lines) throw new ApiError(400, 'VALIDATION_ERROR', 'Lines required', { lines: ['required'] });
    lines = await resolveLines(ctx, input.lines);
  }
  const sums = totals(lines, input.taxPercent);
  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.create({
      data: {
        organizationId: ctx.organizationId,
        poNumber: await nextNumber(tx, ctx.organizationId),
        vendorId: vendor.id,
        salesOrderId: input.salesOrderId ?? null,
        subject: input.subject,
        currency: input.currency ?? vendor.currency,
        taxPercent: input.taxPercent,
        ...sums,
        expectedDate: input.expectedDate ?? null,
        deliveryAddress: deliveryAddress ?? null,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });
    // 明细单独写入（组合外键下嵌套创建不接受 organizationId）/ lines are written separately (nested creates reject organizationId under the composite FK)
    await tx.purchaseOrderLineItem.createMany({ data: lines.map((l, i) => ({ ...l, organizationId: ctx.organizationId, purchaseOrderId: po.id, position: i + 1 })) });
    const created = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: detailInclude });
    await audit(tx, { ...by(ctx), action: 'purchase.create', entityType: 'purchase', entityId: po.id, changes: { after: snapshot('purchase', created), lines: created.lines.length } });
    return created;
  });
}

/**
 * 修改采购单：草稿可改全部；已下单、部分到货只能改主题、预计到货日、收货地址、备注；终态不可改。乐观并发。
 * Update: drafts change everything; ordered and partially received orders only subject, expected date, address and
 * notes; final orders nothing. Optimistic concurrency.
 */
export async function updatePurchaseOrder(ctx: AuthContext, id: string, input: z.infer<typeof poUpdateSchema>) {
  requirePermission(ctx, 'purchase.manage');
  const current = await prisma.purchaseOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!current) throw notFound();
  if (DONE.includes(current.status)) throw new ApiError(409, 'CONFLICT', 'Purchase order is final', { status: ['final'] });
  const draftOnly = (['vendorId', 'currency', 'taxPercent', 'lines'] as const).filter((k) => input[k] !== undefined);
  if (current.status !== PurchaseOrderStatus.DRAFT && draftOnly.length) {
    throw new ApiError(409, 'CONFLICT', 'Only drafts can change these fields', Object.fromEntries(draftOnly.map((k) => [k, ['draft_only']])));
  }
  if (input.vendorId) await requireVendor(ctx, input.vendorId);
  const { lines: lineInput, ...data } = input;
  const lines = lineInput ? await resolveLines(ctx, lineInput) : null;
  const sums = lines || input.taxPercent !== undefined ? totals(lines ?? current.lines, input.taxPercent ?? current.taxPercent) : {};
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.purchaseOrder.updateMany({ where: { id, organizationId: ctx.organizationId, updatedAt: current.updatedAt }, data: { ...data, ...sums } });
    if (!count) throw new ApiError(409, 'CONFLICT', 'Purchase order was changed by someone else', { purchaseOrder: ['stale'] });
    if (lines) {
      await tx.purchaseOrderLineItem.deleteMany({ where: { organizationId: ctx.organizationId, purchaseOrderId: id } });
      await tx.purchaseOrderLineItem.createMany({ data: lines.map((l, i) => ({ ...l, organizationId: ctx.organizationId, purchaseOrderId: id, position: i + 1 })) });
    }
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: detailInclude });
    const fields = diff('purchase', current, po);
    if (Object.keys(fields).length || lines) {
      await audit(tx, { ...by(ctx), action: 'purchase.update', entityType: 'purchase', entityId: id, changes: { fields, ...(lines ? { lines: lines.length } : {}) } });
    }
    return po;
  });
}

/**
 * 状态变更：下单（草稿 → 已下单，要求单价大于 0，保存汇率快照）或取消（草稿、尚未收货的已下单）。
 * Status change: order (draft → ordered; positive costs; rate snapshot) or cancel (drafts and orders with nothing received).
 */
export async function changePurchaseOrderStatus(ctx: AuthContext, id: string, input: z.infer<typeof poStatusSchema>) {
  requirePermission(ctx, 'purchase.manage');
  return prisma.$transaction(async (tx) => {
    // 锁定采购单行，与收货、并发状态变更串行 / lock the order row against receiving and concurrent changes
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_orders WHERE organization_id = ${ctx.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();
    const current = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    const now = new Date();
    const data: Prisma.PurchaseOrderUpdateInput = {};
    if (input.status === PurchaseOrderStatus.ORDERED) {
      if (current.status !== PurchaseOrderStatus.DRAFT) throw new ApiError(409, 'CONFLICT', 'Only drafts can be ordered', { status: ['invalid_transition'] });
      const zero = current.lines.filter((l) => l.unitCost.lte(0)).map((l) => l.position);
      if (zero.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Unit cost required', { lines: zero.map((p) => `zero_cost:${p}`) });
      const rate = (await ratesOn(ctx.organizationId, now, tx)).get(current.currency) ?? null;
      Object.assign(data, { status: PurchaseOrderStatus.ORDERED, orderedAt: now, exchangeRate: rate, baseTotal: rate ? toBase(current.total, rate) : null });
    } else {
      const received = current.lines.some((l) => l.receivedQuantity.gt(0));
      if (DONE.includes(current.status) || received) throw new ApiError(409, 'CONFLICT', 'Cannot cancel', { status: [received ? 'has_receipts' : 'invalid_transition'] });
      Object.assign(data, { status: PurchaseOrderStatus.CANCELLED, cancelledAt: now, cancelReason: input.reason ?? null });
    }
    const po = await tx.purchaseOrder.update({ where: { id }, data, include: detailInclude });
    await audit(tx, { ...by(ctx), action: 'purchase.status', entityType: 'purchase', entityId: id, changes: { fields: diff('purchase', current, po) } });
    return po;
  });
}

/**
 * 收货：按行累加收货数量（不超过采购数量），并更新为部分到货或已到货。
 * Receive goods: add per-line quantities (within the ordered amount) and move to partially received or received.
 */
export async function receivePurchaseOrder(ctx: AuthContext, id: string, input: z.infer<typeof poReceiveSchema>) {
  requirePermission(ctx, 'purchase.manage');
  if (new Set(input.lines.map((l) => l.lineId)).size !== input.lines.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Duplicate lines', { lines: ['duplicate'] });
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_orders WHERE organization_id = ${ctx.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();
    const current = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    if (current.status !== PurchaseOrderStatus.ORDERED && current.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED) {
      throw new ApiError(409, 'CONFLICT', 'Only ordered purchase orders can receive goods', { status: ['not_ordered'] });
    }
    const received: { sku: string; quantity: string }[] = [];
    for (const r of input.lines) {
      const line = current.lines.find((l) => l.id === r.lineId);
      if (!line) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid line', { lineId: ['not_found'] });
      const next = line.receivedQuantity.plus(r.quantity);
      if (next.gt(line.quantity)) throw new ApiError(400, 'VALIDATION_ERROR', 'Over-receipt', { lines: [`over:${line.position}`] });
      await tx.purchaseOrderLineItem.update({ where: { id: line.id }, data: { receivedQuantity: next } });
      received.push({ sku: line.productSku, quantity: r.quantity });
    }
    const after = await tx.purchaseOrderLineItem.findMany({ where: { purchaseOrderId: id } });
    const complete = after.every((l) => l.receivedQuantity.equals(l.quantity));
    const po = await tx.purchaseOrder.update({
      where: { id },
      data: complete ? { status: PurchaseOrderStatus.RECEIVED, receivedAt: new Date() } : { status: PurchaseOrderStatus.PARTIALLY_RECEIVED },
      include: detailInclude,
    });
    await audit(tx, { ...by(ctx), action: 'purchase.receive', entityType: 'purchase', entityId: id, changes: { received, status: [current.status, po.status] } });
    return po;
  });
}

/**
 * 删除采购单（只能删除草稿；编号不复用）。
 * Delete a purchase order (drafts only; the number is never reused).
 */
export async function deletePurchaseOrder(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'purchase.manage');
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_orders WHERE organization_id = ${ctx.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();
    const current = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    if (current.status !== PurchaseOrderStatus.DRAFT) throw new ApiError(409, 'CONFLICT', 'Only drafts can be deleted', { status: ['not_draft'] });
    await tx.purchaseOrder.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'purchase.delete', entityType: 'purchase', entityId: id, changes: { before: snapshot('purchase', current) } });
  });
}
