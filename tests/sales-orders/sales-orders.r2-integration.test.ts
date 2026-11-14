/**
 * 销售订单 第二轮：集成测试（角色权限与可见范围、跨组织隔离、并发生成与并发流转、参数校验、快照不受后续修改影响、
 * 数据库约束兜底、批量删除商机、审计筛选、未登录与跨域预检）。
 * Sales orders round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as productItem from '@/app/api/products/[id]/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as orderItem from '@/app/api/sales-orders/[id]/route';
import * as orderStatus from '@/app/api/sales-orders/[id]/status/route';
import * as orders from '@/app/api/sales-orders/route';
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
let deal: { id: string };
let quote: { id: string };

/** 建一个带明细的商机及其已接受的报价单 / a deal with one line item and its accepted quote */
async function acceptedQuote(who: Who, productId: string, name = '商机') {
  const acc = (await call(accounts.POST, { token: who.token, body: { name: `${name}客户` } })).json;
  const d = (await call(deals.POST, { token: who.token, body: { name, accountId: acc.id } })).json;
  await call(dealItems.POST, { token: who.token, params: { id: d.id }, body: { productId, quantity: '2' } });
  const q = (await call(quotes.POST, { token: who.token, body: { dealId: d.id } })).json;
  await call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  return { deal: d as { id: string }, quote: q as { id: string } };
}
const create = (who: Who, body: object = {}) => call(orders.POST, { token: who.token, body: { quoteId: quote.id, ...body } });
const setStatus = (who: Who, id: string, body: object) => call(orderStatus.POST, { token: who.token, params: { id }, body });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  product = (await call(products.POST, { token: admin.token, body: { sku: 'P-1', name: '产品', unitPrice: '100' } })).json;
  ({ deal, quote } = await acceptedQuote(sales1, product.id, '销售1商机'));
});

describe('sales orders R2 permissions & isolation', () => {
  it('生成：负责人与经理可以，其他销售 404，只读 403 / create follows deal edit rights', async () => {
    expect((await create(sales2)).status).toBe(404);
    expect((await create(viewer)).status).toBe(403);
    expect((await create(sales1)).status).toBe(201);
    const q2 = await acceptedQuote(sales1, product.id, '第二商机');
    expect((await create(manager, { quoteId: q2.quote.id })).status).toBe(201);
  });

  it('查看与操作：只读可看不可改；其他销售看不到也改不了 / view and change rights', async () => {
    const o = (await create(sales1)).json;
    expect((await call(orders.GET, { token: viewer.token })).json.total).toBe(1);
    expect((await call(orderItem.GET, { token: viewer.token, params: { id: o.id } })).status).toBe(200);
    expect((await setStatus(viewer, o.id, { status: 'SHIPPED' })).status).toBe(403);
    expect((await call(orderItem.PATCH, { token: viewer.token, params: { id: o.id }, body: { notes: 'x' }, method: 'PATCH' })).status).toBe(403);
    expect((await call(orders.GET, { token: sales2.token })).json.total).toBe(0);
    expect((await call(orderItem.GET, { token: sales2.token, params: { id: o.id } })).status).toBe(404);
    expect((await setStatus(sales2, o.id, { status: 'CANCELLED' })).status).toBe(404);
    expect((await setStatus(manager, o.id, { status: 'SHIPPED' })).status).toBe(200);
  });

  it('跨组织：看不到、改不了、不能用对方报价单生成 / cross-tenant isolation', async () => {
    const o = (await create(sales1)).json;
    expect((await call(orders.GET, { token: other.token })).json.total).toBe(0);
    expect((await call(orderItem.GET, { token: other.token, params: { id: o.id } })).status).toBe(404);
    expect((await call(orderItem.PATCH, { token: other.token, params: { id: o.id }, body: { notes: 'x' }, method: 'PATCH' })).status).toBe(404);
    expect((await setStatus(other, o.id, { status: 'CANCELLED' })).status).toBe(404);
    expect((await create(other)).status).toBe(404);
    const row = await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.status).toBe('CONFIRMED');
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(orders.GET)).status).toBe(401);
    expect((await call(orders.POST, { body: { quoteId: quote.id } })).status).toBe(401);
  });
});

describe('sales orders R2 concurrency', () => {
  it('同一报价单并发生成只成功一张 / concurrent creation yields one order', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create(sales1)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await prisma.salesOrder.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'order.create' } })).toBe(1);
  });

  it('不同报价单并发生成，订单号连续不重复 / concurrent numbering', async () => {
    const qs = [quote.id, ...(await Promise.all([1, 2, 3].map(async (n) => (await acceptedQuote(admin, product.id, `并发${n}`)).quote.id)))];
    const results = await Promise.all(qs.map((id) => create(admin, { quoteId: id })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const year = new Date().getUTCFullYear();
    expect(results.map((r) => r.json.orderNumber).sort()).toEqual([1, 2, 3, 4].map((n) => `SO-${year}-000${n}`));
  });

  it('并发发货与取消只成功一个 / concurrent transitions', async () => {
    const o = (await create(sales1)).json;
    const [x, y] = await Promise.all([setStatus(sales1, o.id, { status: 'SHIPPED' }), setStatus(manager, o.id, { status: 'CANCELLED' })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { entityId: o.id, action: 'order.status' } })).toBe(1);
  });
});

describe('sales orders R2 validation & integrity', () => {
  it('参数校验 / validation', async () => {
    const badCreate = [{}, { quoteId: 'x' }, { quoteId: quote.id, organizationId: other.org.id }, { quoteId: quote.id, total: '1' }, { quoteId: quote.id, status: 'DELIVERED' }, { quoteId: quote.id, subject: '  ' }, { quoteId: quote.id, expectedDelivery: '2026-13-01' }, { quoteId: quote.id, shippingAddress: 'x'.repeat(501) }];
    for (const body of badCreate) expect((await call(orders.POST, { token: sales1.token, body })).status).toBe(400);
    const o = (await create(sales1)).json;
    for (const body of [{ status: 'X' }, { status: 'SHIPPED', reason: '不需要' }, { status: 'CANCELLED', reason: 'x'.repeat(501) }, {}]) {
      expect((await setStatus(sales1, o.id, body)).status).toBe(400);
    }
    for (const body of [{ total: '1' }, { status: 'SHIPPED' }, { lines: [] }, { quoteId: quote.id }]) {
      expect((await call(orderItem.PATCH, { token: sales1.token, params: { id: o.id }, body, method: 'PATCH' })).status).toBe(400);
    }
    for (const query of [{ status: 'OPEN' }, { quoteId: 'x' }, { pageSize: '101' }] as Record<string, string>[]) {
      expect((await call(orders.GET, { token: sales1.token, query })).status).toBe(400);
    }
    expect(await prisma.auditLog.count({ where: { entityType: 'order' } })).toBe(1);
  });

  it('订单是快照：之后改产品价格、商机明细不影响订单 / orders are snapshots', async () => {
    const o = (await create(sales1)).json;
    await call(productItem.PATCH, { token: admin.token, params: { id: product.id }, body: { unitPrice: '999', name: '改名产品' }, method: 'PATCH' });
    await call(dealItems.POST, { token: sales1.token, params: { id: deal.id }, body: { productId: product.id, quantity: '5' } });
    const again = (await call(orderItem.GET, { token: sales1.token, params: { id: o.id } })).json;
    expect(again.lines).toEqual(o.lines);
    expect(again.total).toBe(o.total);
  });

  it('数据库兜底：第二张未取消订单、金额不一致、无发货时间的已发货状态都被拒绝；报价单不能被删除 / DB guards', async () => {
    const o = (await create(sales1)).json;
    const base = await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id } });
    const data = { ...base, id: crypto.randomUUID(), orderNumber: 'SO-X-1', createdAt: undefined, updatedAt: undefined };
    await expect(prisma.salesOrder.create({ data })).rejects.toThrow();
    await expect(prisma.salesOrder.update({ where: { id: o.id }, data: { total: '1' } })).rejects.toThrow();
    await expect(prisma.salesOrder.update({ where: { id: o.id }, data: { status: 'SHIPPED' } })).rejects.toThrow();
    await expect(prisma.salesOrder.update({ where: { id: o.id }, data: { status: 'CANCELLED' } })).rejects.toThrow();
    await expect(prisma.quote.delete({ where: { id: quote.id } })).rejects.toThrow();
    expect(await prisma.salesOrder.count()).toBe(1);
  });

  it('批量删除商机时有订单的商机失败并说明原因 / bulk delete reports deals with orders', async () => {
    await create(sales1);
    const other = (await call(deals.POST, { token: admin.token, body: { name: '无订单商机', accountId: (await call(accounts.POST, { token: admin.token, body: { name: '另一客户' } })).json.id } })).json;
    const r = await call(dealBulk.POST, { token: admin.token, body: { action: 'delete', ids: [deal.id, other.id] } });
    expect(r.status).toBe(200);
    expect(r.json.succeeded).toEqual([other.id]);
    expect(r.json.failed).toEqual([expect.objectContaining({ id: deal.id, code: 'CONFLICT' })]);
    expect(await prisma.deal.count({ where: { id: deal.id } })).toBe(1);
  });

  it('审计日志可按销售订单筛选 / audit log filter by order', async () => {
    const o = (await create(sales1)).json;
    await setStatus(sales1, o.id, { status: 'SHIPPED' });
    const r = await call(auditLogs.GET, { token: admin.token, query: { entityType: 'order' } });
    expect(r.status).toBe(200);
    expect(r.json.items.map((x: { action: string }) => x.action).sort()).toEqual(['order.create', 'order.status']);
    expect((await call(auditLogs.GET, { token: admin.token, query: { action: 'order.status' } })).json.total).toBe(1);
  });
});

describe('sales orders R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET/POST/PATCH / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await orderItem.OPTIONS(new Request('http://localhost/api/sales-orders/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    for (const m of ['GET', 'POST', 'PATCH']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
  });
});
