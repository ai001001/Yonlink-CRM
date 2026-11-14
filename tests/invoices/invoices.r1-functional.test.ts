/**
 * 发票 第一轮：功能测试（由订单生成、快照与默认值、编号、收款与状态、撤销收款、作废与重新开票、修改与日期校验、
 * 逾期筛选、订单取消受限、审计、演示数据）。
 * Invoices round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME, demoInvoices } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as orderItem from '@/app/api/sales-orders/[id]/route';
import * as orderStatus from '@/app/api/sales-orders/[id]/status/route';
import * as orders from '@/app/api/sales-orders/route';
import * as payment from '@/app/api/invoices/[id]/payments/[paymentId]/route';
import * as payments from '@/app/api/invoices/[id]/payments/route';
import * as invoiceItem from '@/app/api/invoices/[id]/route';
import * as voidRoute from '@/app/api/invoices/[id]/void/route';
import * as invoices from '@/app/api/invoices/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let order: { id: string; orderNumber: string };
const year = new Date().getUTCFullYear();
const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

const create = (body: object = {}) => call(invoices.POST, { token: a.token, body: { salesOrderId: order.id, ...body } });
const pay = (id: string, amount: string, extra: object = {}) =>
  call(payments.POST, { token: a.token, params: { id }, body: { amount, paidOn: today(), method: 'BANK_TRANSFER', ...extra } });
const revert = (id: string, paymentId: string) => call(payment.DELETE, { token: a.token, params: { id, paymentId }, method: 'DELETE' });
const voidIt = (id: string, body: object = {}) => call(voidRoute.POST, { token: a.token, params: { id }, body });
const patch = (id: string, body: object) => call(invoiceItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '发票客户', address: '上海市演示路 1 号' } })).json;
  const deal = (await call(deals.POST, { token: a.token, body: { name: '发票商机', accountId: acc.id } })).json;
  const p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '增压器', unit: '台', unitPrice: '1000' } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: p.id, quantity: '3', discountPercent: '10' } });
  const q = (await call(quotes.POST, { token: a.token, body: { dealId: deal.id, taxPercent: '13' } })).json;
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  order = (await call(orders.POST, { token: a.token, body: { quoteId: q.id, shippingAddress: '苏州市收货路 2 号' } })).json;
});

describe('invoices R1 create', () => {
  it('由订单生成：明细与金额快照、编号、默认日期与开票地址 / create from an order', async () => {
    const res = await create({ notes: '请注明发票号' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      invoiceNumber: `INV-${year}-0001`,
      subject: '发票商机',
      status: 'UNPAID',
      currency: 'CNY',
      subtotal: '2700',
      taxAmount: '351',
      total: '3051',
      paidAmount: '0',
      billingAddress: '苏州市收货路 2 号',
      notes: '请注明发票号',
      salesOrder: { id: order.id, orderNumber: order.orderNumber },
      payments: [],
    });
    expect(res.json.invoiceDate.slice(0, 10)).toBe(today());
    expect(res.json.dueDate.slice(0, 10)).toBe(daysFromNow(30));
    expect(res.json.lines).toEqual([expect.objectContaining({ position: 1, productSku: 'P-1', quantity: '3', lineTotal: '2700' })]);
    expect((await prisma.auditLog.findMany({ where: { entityId: res.json.id } })).map((x) => x.action)).toEqual(['invoice.create']);
    const o = (await call(orderItem.GET, { token: a.token, params: { id: order.id } })).json;
    expect(o.invoices).toEqual([{ id: res.json.id, invoiceNumber: res.json.invoiceNumber, status: 'UNPAID' }]);
  });

  it('自定义日期；到期日早于开票日期 400；重复开票 409；取消的订单不能开票 / rules', async () => {
    expect((await create({ invoiceDate: '2026-11-01', dueDate: '2026-10-31' })).json.error.details).toEqual({ dueDate: ['before_invoice_date'] });
    const inv = (await create({ invoiceDate: '2026-11-01', dueDate: '2026-11-15', subject: '首期发票' })).json;
    expect(inv).toMatchObject({ subject: '首期发票' });
    expect(inv.dueDate.slice(0, 10)).toBe('2026-11-15');
    const dup = await create();
    expect(dup.status).toBe(409);
    expect(dup.json.error.details).toEqual({ salesOrderId: ['has_invoice'] });
    // 订单有未作废发票时不能取消 / the order cannot be cancelled while it has an active invoice
    const cancel = await call(orderStatus.POST, { token: a.token, params: { id: order.id }, body: { status: 'CANCELLED' } });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error.details).toEqual({ invoices: ['1'] });
    expect((await voidIt(inv.id)).status).toBe(200);
    expect((await call(orderStatus.POST, { token: a.token, params: { id: order.id }, body: { status: 'CANCELLED' } })).status).toBe(200);
    const r = await create();
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ salesOrderId: ['cancelled'] });
  });
});

describe('invoices R1 payments', () => {
  it('部分付款 → 付清，余额与状态随之变化；超额收款 409；付清后不能再收款 / payments drive the status', async () => {
    const inv = (await create()).json;
    const p1 = await pay(inv.id, '1000.50', { method: 'CHECK', reference: 'CHK-1' });
    expect(p1.status).toBe(201);
    expect(p1.json).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: '1000.5', paidAt: null });
    expect(p1.json.payments).toEqual([expect.objectContaining({ amount: '1000.5', method: 'CHECK', reference: 'CHK-1', recordedBy: { id: a.user.id, name: a.user.name } })]);
    const over = await pay(inv.id, '2050.51');
    expect(over.status).toBe(409);
    expect(over.json.error.details).toEqual({ amount: ['exceeds_balance'] });
    const p2 = await pay(inv.id, '2050.50');
    expect(p2.json).toMatchObject({ status: 'PAID', paidAmount: '3051' });
    expect(p2.json.paidAt).not.toBeNull();
    const after = await pay(inv.id, '1');
    expect(after.status).toBe(409);
    expect(after.json.error.details).toEqual({ status: ['paid'] });
    const logs = await prisma.auditLog.findMany({ where: { entityId: inv.id, action: 'invoice.payment' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.changes)).toEqual([
      expect.objectContaining({ amount: '1000.50', method: 'CHECK', fields: { paidAmount: ['0.00', '1000.50'], status: ['UNPAID', 'PARTIALLY_PAID'] } }),
      expect.objectContaining({ amount: '2050.50', method: 'BANK_TRANSFER', fields: { paidAmount: ['1000.50', '3051.00'], status: ['PARTIALLY_PAID', 'PAID'] } }),
    ]);
  });

  it('撤销收款：已付清 → 部分付款 → 未付款 / reverting payments', async () => {
    const inv = (await create()).json;
    await pay(inv.id, '51');
    const paid = (await pay(inv.id, '3000')).json;
    const r1 = await revert(inv.id, paid.payments[1].id);
    expect(r1.json).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: '51', paidAt: null });
    const r2 = await revert(inv.id, paid.payments[0].id);
    expect(r2.json).toMatchObject({ status: 'UNPAID', paidAmount: '0', payments: [] });
    expect((await revert(inv.id, paid.payments[0].id)).status).toBe(404);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: inv.id, action: 'invoice.payment_delete' }, orderBy: { createdAt: 'asc' } });
    expect(log.changes).toMatchObject({ amount: '3000.00', fields: { paidAmount: ['3051.00', '51.00'], status: ['PAID', 'PARTIALLY_PAID'] } });
  });

  it('作废：有收款不能作废；撤销后可作废，作废后不能修改或收款，可重新开票 / void', async () => {
    const inv = (await create()).json;
    const p = (await pay(inv.id, '10')).json;
    const blocked = await voidIt(inv.id);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details).toEqual({ status: ['has_payments'] });
    await revert(inv.id, p.payments[0].id);
    const v = await voidIt(inv.id, { reason: '开票信息有误' });
    expect(v.json).toMatchObject({ status: 'VOID', voidReason: '开票信息有误' });
    expect(v.json.voidedAt).not.toBeNull();
    for (const r of [await pay(inv.id, '1'), await patch(inv.id, { notes: 'x' }), await voidIt(inv.id)]) {
      expect(r.status).toBe(409);
      expect(r.json.error.details).toEqual({ status: ['void'] });
    }
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: inv.id, action: 'invoice.void' } });
    expect(log.changes).toEqual({ fields: { status: ['UNPAID', 'VOID'], voidReason: [null, '[redacted]'] } });
    const again = await create();
    expect(again.status).toBe(201);
    expect(again.json.invoiceNumber).toBe(`INV-${year}-0002`);
  });
});

describe('invoices R1 edit & list', () => {
  it('修改主题与日期（到期日不能早于开票日期）并写审计 / update with date check', async () => {
    const inv = (await create({ invoiceDate: '2026-11-01', dueDate: '2026-12-01' })).json;
    expect((await patch(inv.id, { dueDate: '2026-10-01' })).json.error.details).toEqual({ dueDate: ['before_invoice_date'] });
    const r = await patch(inv.id, { subject: '改名发票', dueDate: '2026-12-31', billingAddress: '新地址' });
    expect(r.status).toBe(200);
    expect(r.json.dueDate.slice(0, 10)).toBe('2026-12-31');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: inv.id, action: 'invoice.update' } });
    expect(log.changes).toMatchObject({ fields: { subject: ['发票商机', '改名发票'], billingAddress: ['[redacted]', '[redacted]'] } });
    expect(Object.keys((log.changes as { fields: object }).fields)).toContain('dueDate');
  });

  it('列表：状态、逾期筛选与搜索 / list filters', async () => {
    const inv = (await create({ invoiceDate: '2026-01-01', dueDate: '2026-01-31' })).json;
    const ids = async (query: Record<string, string>) => (await call(invoices.GET, { token: a.token, query })).json.items.map((x: { id: string }) => x.id);
    expect(await ids({ status: 'OVERDUE' })).toEqual([inv.id]);
    expect(await ids({ status: 'UNPAID' })).toEqual([inv.id]);
    await pay(inv.id, '3051');
    expect(await ids({ status: 'OVERDUE' })).toEqual([]);
    expect(await ids({ status: 'PAID' })).toEqual([inv.id]);
    for (const q of [inv.invoiceNumber, order.orderNumber, '发票客户']) expect(await ids({ q })).toEqual([inv.id]);
    expect(await ids({ q: '不存在' })).toEqual([]);
  });
});

describe('invoices R1 demo', () => {
  it('演示发票：来自订单，已收金额等于收款合计，状态与逾期符合定义 / demo invoices', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const expected = demoInvoices(buildDemoData());
    const rows = await prisma.invoice.findMany({ where: { organizationId: org.id }, include: { payments: true, salesOrder: true, lines: true }, orderBy: { invoiceNumber: 'asc' } });
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((r) => r.status)).toEqual(['PAID', 'PAID', 'PARTIALLY_PAID', 'UNPAID', 'UNPAID']);
    const todayDate = new Date(new Date().toISOString().slice(0, 10));
    expect(rows.map((r) => r.status !== 'PAID' && r.dueDate < todayDate)).toEqual([false, false, true, true, false]);
    for (const r of rows) {
      expect(r.total.toString()).toBe(r.salesOrder.total.toString());
      expect(r.lines.length).toBeGreaterThan(0);
      const sum = r.payments.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0);
      expect(sum).toBe(Math.round(Number(r.paidAmount) * 100));
      for (const p of r.payments) expect(p.paidOn.getTime()).toBeLessThanOrEqual(Date.now());
      expect(['SHIPPED', 'DELIVERED']).toContain(r.salesOrder.status);
    }
  });
});
