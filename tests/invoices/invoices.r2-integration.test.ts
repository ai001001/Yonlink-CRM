/**
 * 发票 第二轮：集成测试（角色权限与可见范围、跨组织隔离、并发收款不超收、作废与收款并发、开票与取消订单并发、
 * 并发开票、参数校验、数据库约束兜底、审计筛选、未登录与跨域预检）。
 * Invoices round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as orderStatus from '@/app/api/sales-orders/[id]/status/route';
import * as orders from '@/app/api/sales-orders/route';
import * as payment from '@/app/api/invoices/[id]/payments/[paymentId]/route';
import * as payments from '@/app/api/invoices/[id]/payments/route';
import * as invoiceItem from '@/app/api/invoices/[id]/route';
import * as voidRoute from '@/app/api/invoices/[id]/void/route';
import * as invoices from '@/app/api/invoices/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let product: { id: string };
let order: { id: string };

/** 建一张未开票的销售订单（单价 100 × 2，总计 200）/ a sales order (100 × 2 = 200) */
async function newOrder(who: Who, name = '商机') {
  const acc = (await call(accounts.POST, { token: who.token, body: { name: `${name}客户` } })).json;
  const d = (await call(deals.POST, { token: who.token, body: { name, accountId: acc.id } })).json;
  await call(dealItems.POST, { token: who.token, params: { id: d.id }, body: { productId: product.id, quantity: '2' } });
  const q = (await call(quotes.POST, { token: who.token, body: { dealId: d.id } })).json;
  await call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  return (await call(orders.POST, { token: who.token, body: { quoteId: q.id } })).json as { id: string };
}
const create = (who: Who, body: object = {}) => call(invoices.POST, { token: who.token, body: { salesOrderId: order.id, ...body } });
const pay = (who: Who, id: string, amount: string) => call(payments.POST, { token: who.token, params: { id }, body: { amount, paidOn: '2026-11-14', method: 'CASH' } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  product = (await call(products.POST, { token: admin.token, body: { sku: 'P-1', name: '产品', unitPrice: '100' } })).json;
  order = await newOrder(sales1, '销售1商机');
});

describe('invoices R2 permissions & isolation', () => {
  it('生成、收款、作废：负责人与经理可以；其他销售 404；只读 403 / rights follow the deal', async () => {
    expect((await create(sales2)).status).toBe(404);
    expect((await create(viewer)).status).toBe(403);
    const inv = (await create(sales1)).json;
    expect((await pay(sales2, inv.id, '1')).status).toBe(404);
    expect((await pay(viewer, inv.id, '1')).status).toBe(403);
    expect((await pay(manager, inv.id, '1')).status).toBe(201);
    expect((await call(invoices.GET, { token: viewer.token })).json.total).toBe(1);
    expect((await call(invoices.GET, { token: sales2.token })).json.total).toBe(0);
    expect((await call(invoiceItem.GET, { token: sales2.token, params: { id: inv.id } })).status).toBe(404);
    expect((await call(voidRoute.POST, { token: viewer.token, params: { id: inv.id }, body: {} })).status).toBe(403);
  });

  it('跨组织：看不到、不能收款、不能撤销对方收款、不能用对方订单开票 / cross-tenant isolation', async () => {
    const inv = (await create(sales1)).json;
    const paid = (await pay(sales1, inv.id, '50')).json;
    expect((await call(invoices.GET, { token: other.token })).json.total).toBe(0);
    expect((await call(invoiceItem.GET, { token: other.token, params: { id: inv.id } })).status).toBe(404);
    expect((await pay(other, inv.id, '1')).status).toBe(404);
    expect((await call(payment.DELETE, { token: other.token, params: { id: inv.id, paymentId: paid.payments[0].id }, method: 'DELETE' })).status).toBe(404);
    expect((await call(voidRoute.POST, { token: other.token, params: { id: inv.id }, body: {} })).status).toBe(404);
    expect((await create(other)).status).toBe(404);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.paidAmount.toString()).toBe('50');
  });

  it('撤销收款时收款必须属于该发票 / a payment must belong to the invoice', async () => {
    const inv = (await create(sales1)).json;
    const order2 = await newOrder(sales1, '第二商机');
    const inv2 = (await call(invoices.POST, { token: sales1.token, body: { salesOrderId: order2.id } })).json;
    const p = (await pay(sales1, inv2.id, '10')).json.payments[0];
    expect((await call(payment.DELETE, { token: sales1.token, params: { id: inv.id, paymentId: p.id }, method: 'DELETE' })).status).toBe(404);
    expect(await prisma.invoicePayment.count({ where: { id: p.id } })).toBe(1);
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(invoices.GET)).status).toBe(401);
    expect((await call(invoices.POST, { body: { salesOrderId: order.id } })).status).toBe(401);
  });
});

describe('invoices R2 concurrency', () => {
  it('并发收款合计不超过总计 / concurrent payments never overpay', async () => {
    const inv = (await create(sales1)).json;
    const results = await Promise.all(Array.from({ length: 6 }, () => pay(sales1, inv.id, '60')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { payments: true } });
    expect(row.paidAmount.toString()).toBe('180');
    expect(row.status).toBe('PARTIALLY_PAID');
    expect(row.payments).toHaveLength(3);
    expect(await prisma.auditLog.count({ where: { entityId: inv.id, action: 'invoice.payment' } })).toBe(3);
  });

  it('并发付清：只有一笔能付清 / only one payment settles the invoice', async () => {
    const inv = (await create(sales1)).json;
    const results = await Promise.all(Array.from({ length: 4 }, () => pay(sales1, inv.id, '200')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID');
  });

  it('作废与收款并发只成功一个，数据一致 / void vs payment', async () => {
    const inv = (await create(sales1)).json;
    const [v, p] = await Promise.all([call(voidRoute.POST, { token: sales1.token, params: { id: inv.id }, body: {} }), pay(manager, inv.id, '10')]);
    expect([v.status, p.status].filter((s) => s === 409)).toHaveLength(1);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { payments: true } });
    if (row.status === 'VOID') expect(row.payments).toHaveLength(0);
    else expect(row.paidAmount.toString()).toBe('10');
  });

  it('开票与取消订单并发只成功一个 / invoicing vs order cancellation', async () => {
    const [c, x] = await Promise.all([create(sales1), call(orderStatus.POST, { token: manager.token, params: { id: order.id }, body: { status: 'CANCELLED' } })]);
    // 失败的一方必须是 409 / the losing side must get 409
    expect(c.status === 201 ? x.status : c.status).toBe(409);
    const o = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    const active = await prisma.invoice.count({ where: { salesOrderId: order.id, status: { not: 'VOID' } } });
    // 不允许出现“订单已取消但有有效发票” / never a cancelled order with an active invoice
    expect(o.status === 'CANCELLED' && active > 0).toBe(false);
    expect((c.status === 201 ? 1 : 0) + (x.status === 200 ? 1 : 0)).toBe(1);
  });

  it('同一订单并发开票只成功一张；不同订单编号连续 / concurrent creation', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create(sales1)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const more = await Promise.all([1, 2, 3].map((n) => newOrder(admin, `并发${n}`)));
    const created = await Promise.all(more.map((o) => call(invoices.POST, { token: admin.token, body: { salesOrderId: o.id } })));
    const year = new Date().getUTCFullYear();
    expect(created.map((r) => r.json.invoiceNumber).sort()).toEqual([2, 3, 4].map((n) => `INV-${year}-000${n}`));
  });
});

describe('invoices R2 validation & integrity', () => {
  it('参数校验 / validation', async () => {
    const bad = [{}, { salesOrderId: 'x' }, { salesOrderId: order.id, total: '1' }, { salesOrderId: order.id, organizationId: other.org.id }, { salesOrderId: order.id, status: 'PAID' }, { salesOrderId: order.id, invoiceDate: '2026-02-30' }, { salesOrderId: order.id, billingAddress: 'x'.repeat(501) }];
    for (const body of bad) expect((await call(invoices.POST, { token: sales1.token, body })).status).toBe(400);
    const inv = (await create(sales1)).json;
    const badPay = [{}, { amount: '0', paidOn: '2026-11-14', method: 'CASH' }, { amount: '-1', paidOn: '2026-11-14', method: 'CASH' }, { amount: '1.234', paidOn: '2026-11-14', method: 'CASH' }, { amount: '1', paidOn: '2026-11-14', method: 'BITCOIN' }, { amount: '1', paidOn: 'x', method: 'CASH' }, { amount: '1', paidOn: '2026-11-14', method: 'CASH', reference: 'x'.repeat(101) }, { amount: '1', paidOn: '2026-11-14', method: 'CASH', invoiceId: inv.id }];
    for (const body of badPay) expect((await call(payments.POST, { token: sales1.token, params: { id: inv.id }, body })).status).toBe(400);
    for (const body of [{ total: '1' }, { status: 'PAID' }, { paidAmount: '200' }, { subject: ' ' }]) {
      expect((await call(invoiceItem.PATCH, { token: sales1.token, params: { id: inv.id }, body, method: 'PATCH' })).status).toBe(400);
    }
    expect((await call(voidRoute.POST, { token: sales1.token, params: { id: inv.id }, body: { reason: 'x'.repeat(501) } })).status).toBe(400);
    for (const query of [{ status: 'LATE' }, { salesOrderId: 'x' }] as Record<string, string>[]) {
      expect((await call(invoices.GET, { token: sales1.token, query })).status).toBe(400);
    }
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.paidAmount.toString()).toBe('0');
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it('数据库兜底：超收、状态与金额不符、到期日早于开票日、第二张有效发票、删除被引用订单都被拒绝 / DB guards', async () => {
    const inv = (await create(sales1)).json;
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { paidAmount: '201', status: 'PARTIALLY_PAID' } })).rejects.toThrow();
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { paidAmount: '200' } })).rejects.toThrow();
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', paidAmount: '200' } })).rejects.toThrow();
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { dueDate: new Date('2000-01-01') } })).rejects.toThrow();
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { status: 'VOID' } })).rejects.toThrow();
    const base = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    await expect(prisma.invoice.create({ data: { ...base, id: crypto.randomUUID(), invoiceNumber: 'INV-X-1', createdAt: undefined, updatedAt: undefined } })).rejects.toThrow();
    await expect(prisma.salesOrder.delete({ where: { id: order.id } })).rejects.toThrow();
    await expect(prisma.invoicePayment.create({ data: { organizationId: admin.org.id, invoiceId: inv.id, amount: '0', paidOn: new Date(), method: 'CASH' } })).rejects.toThrow();
  });

  it('审计日志可按发票与操作筛选 / audit log filters', async () => {
    const inv = (await create(sales1)).json;
    const p = (await pay(sales1, inv.id, '20')).json.payments[0];
    await call(payment.DELETE, { token: sales1.token, params: { id: inv.id, paymentId: p.id }, method: 'DELETE' });
    await call(voidRoute.POST, { token: sales1.token, params: { id: inv.id }, body: {} });
    const r = await call(auditLogs.GET, { token: admin.token, query: { entityType: 'invoice' } });
    expect(r.json.items.map((x: { action: string }) => x.action).sort()).toEqual(['invoice.create', 'invoice.payment', 'invoice.payment_delete', 'invoice.void']);
    expect((await call(auditLogs.GET, { token: admin.token, query: { action: 'invoice.payment_delete' } })).json.total).toBe(1);
  });
});

describe('invoices R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET/POST/PATCH/DELETE / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await payment.OPTIONS(new Request('http://localhost/api/invoices/x/payments/y', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
  });
});
