/**
 * 发票应用服务（参考 Zoho CRM Invoices）。
 * - 由未取消的销售订单生成：复制订单明细与金额（快照）；发票号按组织、按年连续编号（INV-2026-0001）；
 *   同一订单只能有一张未作废的发票（部分唯一索引兜底并发）；生成时锁定订单行，与取消订单互斥。
 * - 收款：登记金额、日期、方式、凭证号；已收金额不能超过总计；状态随已收金额变化（未付款 / 部分付款 / 已付清）。
 *   登记与撤销都用一条条件更新同时改金额与状态，并发收款不会超收。
 * - 作废：仅限没有收款的发票（可填原因）；作废后不能再修改或收款，订单可以重新开票。
 * - 逾期：未付清且到期日早于今天（UTC 日期），由查询推算，不单独存储。
 * - 发票不能删除；可见与编辑权限跟随所属商机；生成、修改、收款、撤销收款、作废写审计。
 * Invoices (cf. Zoho CRM Invoices): generated from a non-cancelled sales order with a snapshot of its lines and
 * amounts; yearly INV numbering; one non-void invoice per order (partial unique index); the order row is locked so
 * creation and order cancellation exclude each other. Payments (amount, date, method, reference) never exceed the
 * total and drive the status through a single conditional update, so concurrent payments cannot overpay. Void only
 * without payments. Overdue = not fully paid and due before today (UTC), derived at query time. Invoices are never
 * deleted; rights follow the deal; create, update, payment, payment reversal and void are audited.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { InvoiceStatus, PaymentMethod, SalesOrderStatus } from '@/generated/prisma/enums';
import { audit, by, diff, REDACTED, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, visible } from '../permissions';
import { containsText, listQuery, optionalText, requiredText, type Page } from '../validation';
import { amountSchema, dateOnly } from './deals';

/** 默认付款期限（天）/ default payment term in days */
export const DEFAULT_TERM_DAYS = 30;

const date = dateOnly.transform((v) => new Date(`${v}T00:00:00Z`));

/** 由销售订单生成发票 / Create an invoice from a sales order */
export const invoiceCreateSchema = z.strictObject({
  salesOrderId: z.uuid(),
  /** 不填时使用订单主题 / defaults to the order subject */
  subject: requiredText(200).optional(),
  /** 不填时为今天（UTC）/ defaults to today (UTC) */
  invoiceDate: date.optional(),
  /** 不填时为开票日期后 30 天 / defaults to 30 days after the invoice date */
  dueDate: date.optional(),
  /** 不填时使用订单收货地址 / defaults to the order's shipping address */
  billingAddress: optionalText(500).optional(),
  notes: optionalText(5000),
});
/** 修改发票（作废后不可改）/ Update an invoice (not once void) */
export const invoiceUpdateSchema = z
  .strictObject({ subject: requiredText(200), invoiceDate: date, dueDate: date, billingAddress: optionalText(500), notes: optionalText(5000) })
  .partial();
/** 登记收款 / Record a payment */
export const paymentCreateSchema = z.strictObject({
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  paidOn: date,
  method: z.enum(PaymentMethod),
  reference: optionalText(100),
});
/** 作废 / Void */
export const invoiceVoidSchema = z.strictObject({ reason: optionalText(500) });
/** 列表查询（OVERDUE 为逾期筛选）/ List query (OVERDUE filters overdue invoices) */
export const invoiceListSchema = listQuery.extend({
  status: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID', 'VOID', 'OVERDUE']).optional(),
  dealId: z.uuid().optional(),
  salesOrderId: z.uuid().optional(),
});

/** 今天（UTC 日期）/ today as a UTC date */
export const todayUtc = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
/** 可收款的状态 / statuses that accept payments */
const OPEN: InvoiceStatus[] = [InvoiceStatus.UNPAID, InvoiceStatus.PARTIALLY_PAID];

const listInclude = {
  deal: { select: { id: true, name: true, ownerId: true, account: { select: { id: true, name: true } } } },
  salesOrder: { select: { id: true, orderNumber: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.InvoiceInclude;

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
  salesOrder: { select: { id: true, orderNumber: true } },
  createdBy: { select: { id: true, name: true } },
  organization: { select: { name: true } },
  lines: { orderBy: { position: 'asc' } },
  payments: { orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }], include: { recordedBy: { select: { id: true, name: true } } } },
} satisfies Prisma.InvoiceInclude;

/** 订单已有未作废发票 / the order already has an active invoice */
const hasInvoice = () => new ApiError(409, 'CONFLICT', 'Order already has an invoice', { salesOrderId: ['has_invoice'] });
/** 到期日早于开票日期 / due date before the invoice date */
const badDates = () => new ApiError(400, 'VALIDATION_ERROR', 'Due date before invoice date', { dueDate: ['before_invoice_date'] });

/**
 * 在事务内生成下一个发票号（按组织加事务级咨询锁）。
 * Allocate the next invoice number inside the transaction (per-organization advisory lock).
 */
async function nextNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`invoice:${organizationId}`}, 0))`;
  const prefix = `INV-${new Date().getUTCFullYear()}-`;
  // 起始位置必须显式转为 int（否则是正则版本的 substring）/ the start must be cast to int (else the regex form is used)
  const start = prefix.length + 1;
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT max(substring(invoice_number FROM ${start}::int)::int) AS max FROM invoices
    WHERE organization_id = ${organizationId}::uuid AND invoice_number LIKE ${`${prefix}%`} AND substring(invoice_number FROM ${start}::int) ~ '^[0-9]+$'`;
  return `${prefix}${String((rows[0]?.max ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * 分页搜索发票（发票号、主题、订单号、商机、客户），只含可见商机的发票。
 * Search invoices (number, subject, order number, deal, account) on visible deals, paginated.
 */
export async function listInvoices(ctx: AuthContext, query: z.infer<typeof invoiceListSchema>): Promise<Page<unknown>> {
  const status: Prisma.InvoiceWhereInput =
    query.status === 'OVERDUE' ? { status: { in: OPEN }, dueDate: { lt: todayUtc() } } : { status: query.status };
  const where: Prisma.InvoiceWhereInput = {
    AND: [{ organizationId: ctx.organizationId, deal: visible(ctx) }, status, { dealId: query.dealId, salesOrderId: query.salesOrderId }],
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ invoiceNumber: c }, { subject: c }, { salesOrder: { orderNumber: c } }, { deal: { name: c } }, { deal: { account: { name: c } } }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.invoice.findMany({ where, include: listInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.invoice.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 发票详情（含明细、收款、商机、客户、组织名称）；不可见 404。
 * Invoice detail with lines, payments, deal, account and organization name; 404 when not visible.
 */
export async function getInvoice(ctx: AuthContext, id: string) {
  const invoice = await prisma.invoice.findFirst({ where: { id, organizationId: ctx.organizationId, deal: visible(ctx) }, include: detailInclude });
  if (!invoice) throw notFound();
  return invoice;
}

/**
 * 由未取消的销售订单生成发票。
 * Create an invoice from a non-cancelled sales order.
 */
export async function createInvoice(ctx: AuthContext, input: z.infer<typeof invoiceCreateSchema>) {
  const order = await prisma.salesOrder.findFirst({
    where: { id: input.salesOrderId, organizationId: ctx.organizationId, deal: visible(ctx) },
    include: { lines: { orderBy: { position: 'asc' } }, deal: { select: { id: true, ownerId: true } } },
  });
  if (!order) throw notFound();
  assertCanUpdate(ctx, order.deal);
  const invoiceDate = input.invoiceDate ?? todayUtc();
  const dueDate = input.dueDate ?? new Date(invoiceDate.getTime() + DEFAULT_TERM_DAYS * 86400_000);
  if (dueDate < invoiceDate) throw badDates();
  const id = crypto.randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      // 锁定订单行：与取消订单互斥，并读取最新状态 / lock the order row (excludes cancellation) and re-read its status
      const [locked] = await tx.$queryRaw<{ status: SalesOrderStatus }[]>`
        SELECT status FROM sales_orders WHERE id = ${order.id}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
      if (!locked || locked.status === SalesOrderStatus.CANCELLED) {
        throw new ApiError(409, 'CONFLICT', 'Cancelled orders cannot be invoiced', { salesOrderId: ['cancelled'] });
      }
      if (await tx.invoice.count({ where: { organizationId: ctx.organizationId, salesOrderId: order.id, status: { not: InvoiceStatus.VOID } } })) throw hasInvoice();
      // 总计为 0 时直接视为已付清 / a zero total is paid from the start
      const zero = order.total.isZero();
      const invoice = await tx.invoice.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          salesOrderId: order.id,
          dealId: order.dealId,
          invoiceNumber: await nextNumber(tx, ctx.organizationId),
          subject: input.subject ?? order.subject,
          status: zero ? InvoiceStatus.PAID : InvoiceStatus.UNPAID,
          paidAt: zero ? new Date() : null,
          currency: order.currency,
          taxPercent: order.taxPercent,
          subtotal: order.subtotal,
          taxAmount: order.taxAmount,
          total: order.total,
          invoiceDate,
          dueDate,
          billingAddress: input.billingAddress === undefined ? order.shippingAddress : input.billingAddress,
          notes: input.notes,
          createdById: ctx.userId,
        },
      });
      await tx.invoiceLineItem.createMany({
        data: order.lines.map((l) => ({
          organizationId: ctx.organizationId,
          invoiceId: id,
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
      await audit(tx, { ...by(ctx), action: 'invoice.create', entityType: 'invoice', entityId: id, changes: { after: snapshot('invoice', invoice), lines: order.lines.length } });
    });
  } catch (err) {
    // 并发生成时由部分唯一索引拒绝 / concurrent creation is rejected by the partial unique index
    if ((err as { code?: string }).code === 'P2002') throw hasInvoice();
    throw err;
  }
  return getInvoice(ctx, id);
}

/**
 * 读取发票并校验编辑权限与未作废。
 * Load an invoice and check edit rights and that it is not void.
 */
async function requireActive(ctx: AuthContext, id: string) {
  const invoice = await getInvoice(ctx, id);
  assertCanUpdate(ctx, invoice.deal);
  if (invoice.status === InvoiceStatus.VOID) throw new ApiError(409, 'CONFLICT', 'Invoice is void', { status: ['void'] });
  return invoice;
}

/**
 * 修改发票（主题、开票日期、到期日、开票地址、备注）。
 * Update an invoice (subject, invoice date, due date, billing address, notes).
 */
export async function updateInvoice(ctx: AuthContext, id: string, input: z.infer<typeof invoiceUpdateSchema>) {
  const current = await requireActive(ctx, id);
  if ((input.dueDate ?? current.dueDate) < (input.invoiceDate ?? current.invoiceDate)) throw badDates();
  await prisma.$transaction(async (tx) => {
    const n = await tx.invoice.updateMany({ where: { id, status: { not: InvoiceStatus.VOID } }, data: input });
    if (n.count !== 1) throw new ApiError(409, 'CONFLICT', 'Invoice is void', { status: ['void'] });
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id } });
    const fields = diff('invoice', current, invoice);
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'invoice.update', entityType: 'invoice', entityId: id, changes: { fields } });
  });
  return getInvoice(ctx, id);
}

/**
 * 登记收款：一条条件更新同时增加已收金额并改状态，超过未付余额或发票不可收款时 409。
 * Record a payment: one conditional update adds the amount and sets the status; 409 when it exceeds the balance or
 * the invoice cannot take payments.
 */
export async function addPayment(ctx: AuthContext, id: string, input: z.infer<typeof paymentCreateSchema>) {
  const current = await requireActive(ctx, id);
  const amount = new Prisma.Decimal(input.amount);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.$queryRaw<{ status: InvoiceStatus; paid_amount: Prisma.Decimal }[]>`
      UPDATE invoices SET
        paid_amount = paid_amount + ${amount}::numeric,
        status = (CASE WHEN paid_amount + ${amount}::numeric = total THEN 'PAID' ELSE 'PARTIALLY_PAID' END)::invoice_status,
        paid_at = CASE WHEN paid_amount + ${amount}::numeric = total THEN now() ELSE NULL END,
        updated_at = now()
      WHERE id = ${id}::uuid AND organization_id = ${ctx.organizationId}::uuid
        AND status IN ('UNPAID', 'PARTIALLY_PAID') AND paid_amount + ${amount}::numeric <= total
      RETURNING status, paid_amount`;
    if (updated.length !== 1) {
      const now = await tx.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, total: true, paidAmount: true } });
      if (!OPEN.includes(now.status)) throw new ApiError(409, 'CONFLICT', 'Invoice cannot take payments', { status: [now.status === InvoiceStatus.PAID ? 'paid' : 'void'] });
      throw new ApiError(409, 'CONFLICT', 'Payment exceeds the balance', { amount: ['exceeds_balance'] });
    }
    const payment = await tx.invoicePayment.create({
      data: { organizationId: ctx.organizationId, invoiceId: id, amount, paidOn: input.paidOn, method: input.method, reference: input.reference, recordedById: ctx.userId },
    });
    await audit(tx, {
      ...by(ctx),
      action: 'invoice.payment',
      entityType: 'invoice',
      entityId: id,
      changes: {
        paymentId: payment.id,
        amount: amount.toFixed(2),
        method: input.method,
        fields: paymentFields(updated[0]!, amount.neg(), current.total),
      },
    });
  });
  return getInvoice(ctx, id);
}

/**
 * 收款前后的已收金额与状态（由更新后的值反推，并发时也准确）。
 * Paid amount and status before and after a payment change (derived from the updated row, accurate under
 * concurrency).
 * @param delta 撤销前的变化量（登记为 -金额，撤销为 +金额）/ change to undo (−amount for a payment, +amount for a reversal)
 */
function paymentFields(after: { status: InvoiceStatus; paid_amount: Prisma.Decimal }, delta: Prisma.Decimal, total: Prisma.Decimal) {
  const paid = new Prisma.Decimal(after.paid_amount);
  const before = paid.plus(delta);
  const status = before.isZero() ? InvoiceStatus.UNPAID : before.equals(total) ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID;
  return { paidAmount: [before.toFixed(2), paid.toFixed(2)], status: [status, after.status] };
}

/**
 * 撤销一笔收款（删除记录并扣减已收金额，状态随之回退）。
 * Revert a payment (delete it and subtract its amount; the status follows).
 */
export async function deletePayment(ctx: AuthContext, id: string, paymentId: string) {
  const current = await requireActive(ctx, id);
  await prisma.$transaction(async (tx) => {
    const [payment] = await tx.$queryRaw<{ amount: Prisma.Decimal; method: PaymentMethod }[]>`
      DELETE FROM invoice_payments WHERE id = ${paymentId}::uuid AND invoice_id = ${id}::uuid AND organization_id = ${ctx.organizationId}::uuid
      RETURNING amount, method`;
    if (!payment) throw notFound();
    const amount = new Prisma.Decimal(payment.amount);
    const updated = await tx.$queryRaw<{ status: InvoiceStatus; paid_amount: Prisma.Decimal }[]>`
      UPDATE invoices SET
        paid_amount = paid_amount - ${amount}::numeric,
        status = (CASE WHEN paid_amount - ${amount}::numeric = 0 THEN 'UNPAID' ELSE 'PARTIALLY_PAID' END)::invoice_status,
        paid_at = NULL,
        updated_at = now()
      WHERE id = ${id}::uuid AND status <> 'VOID'
      RETURNING status, paid_amount`;
    if (updated.length !== 1) throw new ApiError(409, 'CONFLICT', 'Invoice is void', { status: ['void'] });
    await audit(tx, {
      ...by(ctx),
      action: 'invoice.payment_delete',
      entityType: 'invoice',
      entityId: id,
      changes: {
        paymentId,
        amount: amount.toFixed(2),
        method: payment.method,
        fields: paymentFields(updated[0]!, amount, current.total),
      },
    });
  });
  return getInvoice(ctx, id);
}

/**
 * 作废发票（仅限没有收款的发票）。
 * Void an invoice (only without payments).
 */
export async function voidInvoice(ctx: AuthContext, id: string, input: z.infer<typeof invoiceVoidSchema>) {
  const current = await requireActive(ctx, id);
  await prisma.$transaction(async (tx) => {
    // 条件更新：并发收款时只有一方成功 / conditional update: only one side wins against a concurrent payment
    const n = await tx.invoice.updateMany({
      where: { id, status: { not: InvoiceStatus.VOID }, paidAmount: 0 },
      data: { status: InvoiceStatus.VOID, voidedAt: new Date(), voidReason: input.reason ?? null, paidAt: null },
    });
    if (n.count !== 1) throw new ApiError(409, 'CONFLICT', 'Invoice has payments', { status: ['has_payments'] });
    const fields: Record<string, unknown> = { status: [current.status, InvoiceStatus.VOID] };
    // 作废原因属于长文本，审计中脱敏 / the reason is free text and redacted in the audit
    if (input.reason) fields.voidReason = [null, REDACTED];
    await audit(tx, { ...by(ctx), action: 'invoice.void', entityType: 'invoice', entityId: id, changes: { fields } });
  });
  return getInvoice(ctx, id);
}
