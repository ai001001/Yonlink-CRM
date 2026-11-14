/**
 * 销售订单应用服务（参考 Zoho CRM Sales Orders）。
 * - 由已接受的报价单生成：复制报价单明细与金额（快照，生成后不再变化）；订单号按组织、按年连续编号（SO-2026-0001）。
 * - 同一报价单同时只能有一张未取消的订单（数据库部分唯一索引兜底并发）。
 * - 状态：已确认 → 已发货 → 已交付；已确认、已发货可取消（可填原因）。已交付、已取消为终态，不能再修改。
 * - 订单不能删除（只能取消）；有订单的报价单与商机不能删除。
 * - 可见与编辑权限跟随所属商机；生成、修改、状态变更写审计。
 * Sales orders (cf. Zoho CRM Sales Orders): generated from an accepted quote by snapshotting its lines and amounts;
 * per-organization yearly numbering (SO-2026-0001); one non-cancelled order per quote (a partial unique index guards
 * concurrency); CONFIRMED → SHIPPED → DELIVERED, CONFIRMED/SHIPPED → CANCELLED (optional reason); delivered and
 * cancelled orders are final. Orders are never deleted; quotes and deals with orders cannot be deleted. Visibility
 * and edit rights follow the deal; create, update and status changes are audited.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { QuoteStatus, SalesOrderStatus } from '@/generated/prisma/enums';
import { audit, by, diff, REDACTED, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, visible } from '../permissions';
import { containsText, listQuery, optionalText, requiredText, type Page } from '../validation';
import { dateOnly } from './deals';

const expectedDelivery = dateOnly.nullish().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null));

/** 由报价单生成订单 / Create an order from a quote */
export const orderCreateSchema = z.strictObject({
  quoteId: z.uuid(),
  /** 不填时使用报价单主题 / defaults to the quote subject */
  subject: requiredText(200).optional(),
  expectedDelivery,
  /** 不填时使用客户地址 / defaults to the account address */
  shippingAddress: optionalText(500).optional(),
  notes: optionalText(5000),
});
/** 修改订单（终态不可改）/ Update an order (not in a final status) */
export const orderUpdateSchema = z.strictObject({ subject: requiredText(200), expectedDelivery, shippingAddress: optionalText(500), notes: optionalText(5000) }).partial();
/** 状态变更；取消时可填原因 / Status change; an optional reason when cancelling */
export const orderStatusSchema = z
  .strictObject({ status: z.enum(SalesOrderStatus), reason: optionalText(500) })
  .refine((v) => v.status === SalesOrderStatus.CANCELLED || !v.reason, { path: ['reason'], message: 'Only for cancellation' });
/** 列表查询 / List query */
export const orderListSchema = listQuery.extend({
  status: z.enum(SalesOrderStatus).optional(),
  dealId: z.uuid().optional(),
  quoteId: z.uuid().optional(),
});

/** 允许的状态流转 / Allowed status transitions */
export const ORDER_TRANSITIONS: Record<SalesOrderStatus, readonly SalesOrderStatus[]> = {
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};
/** 终态 / final statuses */
const FINAL: readonly SalesOrderStatus[] = [SalesOrderStatus.DELIVERED, SalesOrderStatus.CANCELLED];

const listInclude = {
  deal: { select: { id: true, name: true, ownerId: true, account: { select: { id: true, name: true } } } },
  quote: { select: { id: true, quoteNumber: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.SalesOrderInclude;

const detailInclude = {
  deal: {
    select: {
      id: true,
      name: true,
      ownerId: true,
      owner: { select: { id: true, name: true } },
      account: { select: { id: true, name: true, phone: true, address: true } },
    },
  },
  quote: { select: { id: true, quoteNumber: true } },
  createdBy: { select: { id: true, name: true } },
  organization: { select: { name: true } },
  lines: { orderBy: { position: 'asc' } },
  invoices: { select: { id: true, invoiceNumber: true, status: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SalesOrderInclude;

/** 报价单已有未取消订单 / the quote already has an active order */
const hasOrder = () => new ApiError(409, 'CONFLICT', 'Quote already has an order', { quoteId: ['has_order'] });

/**
 * 在事务内生成下一个订单号（按组织加事务级咨询锁，避免并发重号）。
 * Allocate the next order number inside the transaction (a per-organization advisory lock prevents duplicates).
 */
async function nextNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`sales_order:${organizationId}`}, 0))`;
  const prefix = `SO-${new Date().getUTCFullYear()}-`;
  // 起始位置必须显式转为 int（否则是正则版本的 substring）/ the start must be cast to int (else the regex form is used)
  const start = prefix.length + 1;
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT max(substring(order_number FROM ${start}::int)::int) AS max FROM sales_orders
    WHERE organization_id = ${organizationId}::uuid AND order_number LIKE ${`${prefix}%`} AND substring(order_number FROM ${start}::int) ~ '^[0-9]+$'`;
  return `${prefix}${String((rows[0]?.max ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * 分页搜索订单（订单号、主题、报价单号、商机、客户），只含可见商机的订单。
 * Search orders (number, subject, quote number, deal, account) on visible deals, paginated.
 */
export async function listOrders(ctx: AuthContext, query: z.infer<typeof orderListSchema>): Promise<Page<unknown>> {
  const where: Prisma.SalesOrderWhereInput = {
    AND: [{ organizationId: ctx.organizationId, deal: visible(ctx) }, { status: query.status, dealId: query.dealId, quoteId: query.quoteId }],
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ orderNumber: c }, { subject: c }, { quote: { quoteNumber: c } }, { deal: { name: c } }, { deal: { account: { name: c } } }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.salesOrder.findMany({ where, include: listInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.salesOrder.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 订单详情（含明细、商机、客户、组织名称，供打印）；不可见 404。
 * Order detail with lines, deal, account and organization name (for printing); 404 when not visible.
 */
export async function getOrder(ctx: AuthContext, id: string) {
  const order = await prisma.salesOrder.findFirst({ where: { id, organizationId: ctx.organizationId, deal: visible(ctx) }, include: detailInclude });
  if (!order) throw notFound();
  return order;
}

/**
 * 由已接受的报价单生成订单。
 * Create an order from an accepted quote.
 */
export async function createOrder(ctx: AuthContext, input: z.infer<typeof orderCreateSchema>) {
  const quote = await prisma.quote.findFirst({
    where: { id: input.quoteId, organizationId: ctx.organizationId, deal: visible(ctx) },
    include: { lines: { orderBy: { position: 'asc' } }, deal: { select: { id: true, ownerId: true, account: { select: { address: true } } } } },
  });
  if (!quote) throw notFound();
  assertCanUpdate(ctx, quote.deal);
  if (quote.status !== QuoteStatus.ACCEPTED) throw new ApiError(409, 'CONFLICT', 'Only accepted quotes can become orders', { quoteId: ['not_accepted'] });
  const active = { organizationId: ctx.organizationId, quoteId: quote.id, status: { not: SalesOrderStatus.CANCELLED } };
  if (await prisma.salesOrder.count({ where: active })) throw hasOrder();
  const id = crypto.randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          quoteId: quote.id,
          dealId: quote.dealId,
          orderNumber: await nextNumber(tx, ctx.organizationId),
          subject: input.subject ?? quote.subject,
          currency: quote.currency,
          taxPercent: quote.taxPercent,
          subtotal: quote.subtotal,
          taxAmount: quote.taxAmount,
          total: quote.total,
          expectedDelivery: input.expectedDelivery,
          shippingAddress: input.shippingAddress === undefined ? (quote.deal.account?.address?.slice(0, 500) ?? null) : input.shippingAddress,
          notes: input.notes,
          createdById: ctx.userId,
        },
      });
      await tx.salesOrderLineItem.createMany({
        data: quote.lines.map((l) => ({
          organizationId: ctx.organizationId,
          salesOrderId: id,
          position: l.position,
          productSku: l.productSku,
          productName: l.productName,
          unit: l.unit,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPercent: l.discountPercent,
          lineTotal: l.lineTotal,
        })),
      });
      await audit(tx, { ...by(ctx), action: 'order.create', entityType: 'order', entityId: id, changes: { after: snapshot('order', order), lines: quote.lines.length } });
    });
  } catch (err) {
    // 并发生成时由部分唯一索引拒绝 / concurrent creation is rejected by the partial unique index
    if ((err as { code?: string }).code === 'P2002') throw hasOrder();
    throw err;
  }
  return getOrder(ctx, id);
}

/**
 * 读取订单并校验编辑权限与非终态。
 * Load an order and check edit rights and that it is not final.
 */
async function requireOpen(ctx: AuthContext, id: string) {
  const order = await getOrder(ctx, id);
  assertCanUpdate(ctx, order.deal);
  if (FINAL.includes(order.status)) throw new ApiError(409, 'CONFLICT', 'Order is closed', { status: ['final'] });
  return order;
}

/**
 * 修改订单（主题、预计交付日期、收货地址、备注）。
 * Update an order (subject, expected delivery, shipping address, notes).
 */
export async function updateOrder(ctx: AuthContext, id: string, input: z.infer<typeof orderUpdateSchema>) {
  const current = await requireOpen(ctx, id);
  await prisma.$transaction(async (tx) => {
    const n = await tx.salesOrder.updateMany({ where: { id, status: { notIn: [...FINAL] } }, data: input });
    if (n.count !== 1) throw new ApiError(409, 'CONFLICT', 'Order is closed', { status: ['final'] });
    const order = await tx.salesOrder.findUniqueOrThrow({ where: { id } });
    const fields = diff('order', current, order);
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'order.update', entityType: 'order', entityId: id, changes: { fields } });
  });
  return getOrder(ctx, id);
}

/**
 * 变更状态（按流转规则；非法流转或并发变更 409）。
 * Change the status following the transition rules (invalid or concurrent transitions → 409).
 */
export async function changeOrderStatus(ctx: AuthContext, id: string, input: z.infer<typeof orderStatusSchema>) {
  const current = await getOrder(ctx, id);
  assertCanUpdate(ctx, current.deal);
  if (!ORDER_TRANSITIONS[current.status].includes(input.status)) {
    throw new ApiError(409, 'CONFLICT', 'Invalid status transition', { status: [`${current.status}->${input.status}`] });
  }
  const now = new Date();
  const data: Prisma.SalesOrderUpdateManyMutationInput = { status: input.status };
  if (input.status === SalesOrderStatus.SHIPPED) data.shippedAt = now;
  if (input.status === SalesOrderStatus.DELIVERED) data.deliveredAt = now;
  if (input.status === SalesOrderStatus.CANCELLED) {
    data.cancelledAt = now;
    data.cancelReason = input.reason ?? null;
  }
  await prisma.$transaction(async (tx) => {
    // 条件更新防止并发重复流转 / conditional update guards against concurrent transitions
    const n = await tx.salesOrder.updateMany({ where: { id, status: current.status }, data });
    if (n.count !== 1) throw new ApiError(409, 'CONFLICT', 'Order was changed concurrently', { status: ['changed'] });
    // 有未作废发票的订单不能取消；在更新（已持有行锁）之后检查，与生成发票互斥
    // orders with an active invoice cannot be cancelled; checked after the update (row lock held) so it excludes invoicing
    if (input.status === SalesOrderStatus.CANCELLED) {
      const invoices = await tx.invoice.count({ where: { organizationId: ctx.organizationId, salesOrderId: id, status: { not: 'VOID' } } });
      if (invoices > 0) throw new ApiError(409, 'CONFLICT', 'Order has invoices', { invoices: [String(invoices)] });
    }
    const fields: Record<string, unknown> = { status: [current.status, input.status] };
    // 取消原因属于长文本，审计中脱敏 / the cancellation reason is free text and redacted in the audit
    if (data.cancelReason) fields.cancelReason = [null, REDACTED];
    await audit(tx, { ...by(ctx), action: 'order.status', entityType: 'order', entityId: id, changes: { fields } });
  });
  return getOrder(ctx, id);
}
