/**
 * 销售订单 第一轮：功能测试（由已接受报价单生成、明细与金额快照、编号、收货地址默认值、状态流转与时间、修改、
 * 取消后重新生成、列表筛选与搜索、报价单详情显示订单、商机删除受限、审计、演示数据）。
 * Sales orders round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME, demoOrders } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as products from '@/app/api/products/route';
import * as quoteItem from '@/app/api/quotes/[id]/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as orderItem from '@/app/api/sales-orders/[id]/route';
import * as orderStatus from '@/app/api/sales-orders/[id]/status/route';
import * as orders from '@/app/api/sales-orders/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let deal: { id: string };

/** 建一张已接受的报价单 / create an accepted quote */
async function acceptedQuote(taxPercent = '13') {
  const q = (await call(quotes.POST, { token: a.token, body: { dealId: deal.id, taxPercent } })).json;
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  return q as { id: string; quoteNumber: string };
}
const create = (body: object) => call(orders.POST, { token: a.token, body });
const setStatus = (id: string, body: object) => call(orderStatus.POST, { token: a.token, params: { id }, body });
const patch = (id: string, body: object) => call(orderItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '订单客户', phone: '021-55550000', address: '上海市演示路 1 号' } })).json;
  deal = (await call(deals.POST, { token: a.token, body: { name: '订单商机', accountId: acc.id } })).json;
  const p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '增压器', unit: '台', unitPrice: '1000' } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: p.id, quantity: '3', discountPercent: '10' } });
});

describe('sales orders R1 create', () => {
  it('由已接受报价单生成：明细与金额快照、编号、默认主题与收货地址 / create from an accepted quote', async () => {
    const q = await acceptedQuote();
    const res = await create({ quoteId: q.id, expectedDelivery: '2026-12-20', notes: '加急' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      orderNumber: `SO-${new Date().getUTCFullYear()}-0001`,
      subject: '订单商机',
      status: 'CONFIRMED',
      currency: 'CNY',
      taxPercent: '13',
      subtotal: '2700',
      taxAmount: '351',
      total: '3051',
      shippingAddress: '上海市演示路 1 号',
      notes: '加急',
      quote: { id: q.id, quoteNumber: q.quoteNumber },
      createdBy: { id: a.user.id },
    });
    expect(res.json.expectedDelivery.slice(0, 10)).toBe('2026-12-20');
    expect(res.json.lines).toEqual([expect.objectContaining({ position: 1, productSku: 'P-1', productName: '增压器', unit: '台', quantity: '3', lineTotal: '2700' })]);
    const audits = await prisma.auditLog.findMany({ where: { entityId: res.json.id } });
    expect(audits.map((x) => x.action)).toEqual(['order.create']);
    // 报价单详情列出订单 / the quote detail lists the order
    const detail = (await call(quoteItem.GET, { token: a.token, params: { id: q.id } })).json;
    expect(detail.salesOrders).toEqual([{ id: res.json.id, orderNumber: res.json.orderNumber, status: 'CONFIRMED' }]);
  });

  it('可自定义主题与收货地址（空表示不填）/ custom subject and empty address', async () => {
    const q = await acceptedQuote();
    const res = await create({ quoteId: q.id, subject: '首批订单', shippingAddress: '' });
    expect(res.json).toMatchObject({ subject: '首批订单', shippingAddress: null, expectedDelivery: null });
  });

  it('未接受的报价单不能生成；已有未取消订单不能重复生成，取消后可以 / guard rules', async () => {
    const draft = (await call(quotes.POST, { token: a.token, body: { dealId: deal.id } })).json;
    const r1 = await create({ quoteId: draft.id });
    expect(r1.status).toBe(409);
    expect(r1.json.error.details).toEqual({ quoteId: ['not_accepted'] });
    const q = await acceptedQuote();
    const first = (await create({ quoteId: q.id })).json;
    const dup = await create({ quoteId: q.id });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details).toEqual({ quoteId: ['has_order'] });
    expect((await setStatus(first.id, { status: 'CANCELLED', reason: '客户改期' })).status).toBe(200);
    const again = await create({ quoteId: q.id });
    expect(again.status).toBe(201);
    expect(again.json.orderNumber).toBe(`SO-${new Date().getUTCFullYear()}-0002`);
  });
});

describe('sales orders R1 lifecycle', () => {
  it('已确认 → 已发货 → 已交付，记录时间；终态不能再改 / confirmed → shipped → delivered', async () => {
    const o = (await create({ quoteId: (await acceptedQuote()).id })).json;
    const shipped = await setStatus(o.id, { status: 'SHIPPED' });
    expect(shipped.json).toMatchObject({ status: 'SHIPPED', deliveredAt: null });
    expect(shipped.json.shippedAt).not.toBeNull();
    const delivered = await setStatus(o.id, { status: 'DELIVERED' });
    expect(delivered.json.status).toBe('DELIVERED');
    expect(delivered.json.deliveredAt).not.toBeNull();
    for (const s of ['CANCELLED', 'SHIPPED', 'CONFIRMED']) expect((await setStatus(o.id, { status: s })).status).toBe(409);
    const edit = await patch(o.id, { notes: 'x' });
    expect(edit.status).toBe(409);
    expect(edit.json.error.details).toEqual({ status: ['final'] });
    const actions = (await prisma.auditLog.findMany({ where: { entityId: o.id }, orderBy: { createdAt: 'asc' } })).map((x) => x.action);
    expect(actions).toEqual(['order.create', 'order.status', 'order.status']);
  });

  it('不能跳过发货直接交付；已发货也可取消，取消原因保存但审计中脱敏 / no skipping; cancel after shipping', async () => {
    const o = (await create({ quoteId: (await acceptedQuote()).id })).json;
    expect((await setStatus(o.id, { status: 'DELIVERED' })).status).toBe(409);
    await setStatus(o.id, { status: 'SHIPPED' });
    const c = await setStatus(o.id, { status: 'CANCELLED', reason: '货物破损，客户拒收' });
    expect(c.json).toMatchObject({ status: 'CANCELLED', cancelReason: '货物破损，客户拒收' });
    expect(c.json.cancelledAt).not.toBeNull();
    expect(c.json.shippedAt).not.toBeNull();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'order.status' }, orderBy: { createdAt: 'desc' } });
    expect(log.changes).toEqual({ fields: { status: ['SHIPPED', 'CANCELLED'], cancelReason: [null, '[redacted]'] } });
  });

  it('修改主题、预计交付、收货地址、备注并写审计（长文本脱敏）/ update with audit', async () => {
    const o = (await create({ quoteId: (await acceptedQuote()).id })).json;
    const r = await patch(o.id, { subject: '改名订单', expectedDelivery: '2027-01-05', shippingAddress: '北京市新地址 2 号' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ subject: '改名订单', shippingAddress: '北京市新地址 2 号', total: '3051' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'order.update' } });
    expect(log.changes).toMatchObject({ fields: { subject: ['订单商机', '改名订单'], shippingAddress: ['[redacted]', '[redacted]'] } });
    // 无变化不写审计 / no audit without changes
    await patch(o.id, { subject: '改名订单' });
    expect(await prisma.auditLog.count({ where: { entityId: o.id, action: 'order.update' } })).toBe(1);
  });
});

describe('sales orders R1 list & deal', () => {
  it('列表按状态筛选、按订单号/报价单号/客户搜索 / list filters and search', async () => {
    const q = await acceptedQuote();
    const o1 = (await create({ quoteId: q.id })).json;
    await setStatus(o1.id, { status: 'CANCELLED' });
    const o2 = (await create({ quoteId: q.id })).json;
    const all = (await call(orders.GET, { token: a.token })).json;
    expect(all.items.map((x: { id: string }) => x.id)).toEqual([o2.id, o1.id]);
    expect((await call(orders.GET, { token: a.token, query: { status: 'CANCELLED' } })).json.total).toBe(1);
    for (const term of [o2.orderNumber, q.quoteNumber, '订单客户']) {
      expect((await call(orders.GET, { token: a.token, query: { q: term } })).json.total).toBeGreaterThan(0);
    }
    expect((await call(orders.GET, { token: a.token, query: { q: '不存在' } })).json.total).toBe(0);
    expect((await call(orders.GET, { token: a.token, query: { quoteId: q.id } })).json.total).toBe(2);
  });

  it('有订单的商机不能删除（含已取消订单）/ deals with orders cannot be deleted', async () => {
    const o = (await create({ quoteId: (await acceptedQuote()).id })).json;
    await setStatus(o.id, { status: 'CANCELLED' });
    const r = await call(dealItem.DELETE, { token: a.token, params: { id: deal.id }, method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ salesOrders: ['1'] });
    expect(await prisma.deal.count({ where: { id: deal.id } })).toBe(1);
  });
});

describe('sales orders R1 demo', () => {
  it('演示订单：来自已接受报价单，金额与明细一致，状态时间符合约束 / demo orders', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const expected = demoOrders(buildDemoData());
    const rows = await prisma.salesOrder.findMany({ where: { organizationId: org.id }, include: { quote: { include: { lines: true } }, lines: true }, orderBy: { orderNumber: 'asc' } });
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((r) => r.status).sort()).toEqual(expected.map((e) => e.status).sort());
    for (const r of rows) {
      expect(r.quote.status).toBe('ACCEPTED');
      expect(r.total.toString()).toBe(r.quote.total.toString());
      expect(r.lines).toHaveLength(r.quote.lines.length);
      expect(r.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      for (const t of [r.shippedAt, r.deliveredAt, r.cancelledAt]) if (t) expect(t.getTime()).toBeLessThanOrEqual(Date.now());
    }
    // 编号按创建时间连续 / numbers follow creation order
    const byCreated = [...rows].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((r) => r.orderNumber);
    expect(byCreated).toEqual(rows.map((r) => r.orderNumber));
  });
});
