/**
 * 报价单 第二轮：集成测试（角色权限、状态流转规则、草稿限制、组织隔离、并发编号与并发流转、异常输入、数据库约束）。
 * Quotes round 2: integration tests (roles, transition rules, draft-only rules, isolation, concurrency, input, DB constraints).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as products from '@/app/api/products/route';
import * as quotes from '@/app/api/quotes/route';
import * as quoteItem from '@/app/api/quotes/[id]/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quoteSync from '@/app/api/quotes/[id]/sync/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let deal: { id: string };
let product: { id: string };

/** 建一个带明细的商机 / create a deal with one line item */
async function itemisedDeal(who: Who, productId: string, name = '商机') {
  const acc = (await call(accounts.POST, { token: who.token, body: { name: `${name}客户` } })).json;
  const d = (await call(deals.POST, { token: who.token, body: { name, accountId: acc.id } })).json;
  await call(dealItems.POST, { token: who.token, params: { id: d.id }, body: { productId, quantity: '2' } });
  return d as { id: string };
}

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  product = (await call(products.POST, { token: admin.token, body: { sku: 'P-1', name: '产品', unitPrice: '100' } })).json;
  deal = await itemisedDeal(sales1, product.id, '销售1商机');
});

const create = (who: Who, body: object = {}) => call(quotes.POST, { token: who.token, body: { dealId: deal.id, ...body } });
const setStatus = (who: Who, id: string, status: string) => call(quoteStatus.POST, { token: who.token, params: { id }, body: { status } });

describe('quotes R2 permissions', () => {
  it('生成：负责人与经理可以；其他销售 404；只读 403 / create follows deal edit rights', async () => {
    expect((await create(sales1)).status).toBe(201);
    expect((await create(manager)).status).toBe(201);
    expect((await create(sales2)).status).toBe(404);
    expect((await create(viewer)).status).toBe(403);
  });

  it('查看：只读可看全部；其他销售列表与详情都看不到 / visibility follows the deal', async () => {
    const q = (await create(sales1)).json;
    expect((await call(quotes.GET, { token: viewer.token })).json.total).toBe(1);
    expect((await call(quoteItem.GET, { token: viewer.token, params: { id: q.id } })).status).toBe(200);
    expect((await call(quotes.GET, { token: sales2.token })).json.total).toBe(0);
    expect((await call(quoteItem.GET, { token: sales2.token, params: { id: q.id } })).status).toBe(404);
  });

  it('修改/同步/状态/删除：只读 403，其他销售 404 / mutations by others are refused', async () => {
    const q = (await create(sales1)).json;
    const attempts = (who: Who) => [
      call(quoteItem.PATCH, { token: who.token, method: 'PATCH', params: { id: q.id }, body: { subject: 'x' } }),
      call(quoteSync.POST, { token: who.token, params: { id: q.id } }),
      setStatus(who, q.id, 'SENT'),
      call(quoteItem.DELETE, { token: who.token, method: 'DELETE', params: { id: q.id } }),
    ];
    expect((await Promise.all(attempts(viewer))).map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect((await Promise.all(attempts(sales2))).map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('DRAFT');
  });

  it('商机改派后，原负责人看不到报价单，新负责人可以操作 / reassignment moves access', async () => {
    const q = (await create(sales1)).json;
    await call(dealItem.PATCH, { token: manager.token, method: 'PATCH', params: { id: deal.id }, body: { ownerId: sales2.user.id } });
    expect((await call(quoteItem.GET, { token: sales1.token, params: { id: q.id } })).status).toBe(404);
    expect((await setStatus(sales2, q.id, 'SENT')).status).toBe(200);
  });
});

describe('quotes R2 rules', () => {
  it('非法状态流转 409，状态不变 / invalid transitions', async () => {
    const q = (await create(admin)).json;
    expect((await setStatus(admin, q.id, 'ACCEPTED')).status).toBe(409);
    expect((await setStatus(admin, q.id, 'DRAFT')).status).toBe(409);
    await setStatus(admin, q.id, 'SENT');
    expect((await setStatus(admin, q.id, 'SENT')).status).toBe(409);
    await setStatus(admin, q.id, 'ACCEPTED');
    for (const s of ['DRAFT', 'SENT', 'REJECTED']) {
      const r = await setStatus(admin, q.id, s);
      expect(r.status).toBe(409);
      expect(r.json.error.details.status).toEqual([`ACCEPTED->${s}`]);
    }
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('ACCEPTED');
  });

  it('非草稿不能修改、同步、删除（409 not_draft）/ only drafts can change', async () => {
    const q = (await create(admin)).json;
    await setStatus(admin, q.id, 'SENT');
    const res = [
      await call(quoteItem.PATCH, { token: admin.token, method: 'PATCH', params: { id: q.id }, body: { subject: 'x' } }),
      await call(quoteSync.POST, { token: admin.token, params: { id: q.id } }),
      await call(quoteItem.DELETE, { token: admin.token, method: 'DELETE', params: { id: q.id } }),
    ];
    for (const r of res) {
      expect(r.status).toBe(409);
      expect(r.json.error.details.status).toEqual(['not_draft']);
    }
  });

  it('商机没有明细时不能生成，也不能把草稿同步为空 / no items', async () => {
    const q = (await create(admin)).json;
    const item = (await call(dealItems.GET, { token: admin.token, params: { id: deal.id } })).json.items[0];
    await call((await import('@/app/api/deal-items/[id]/route')).DELETE, { token: admin.token, method: 'DELETE', params: { id: item.id } });
    const r1 = await create(admin);
    expect(r1.status).toBe(400);
    expect(r1.json.error.details.dealId).toEqual(['no_items']);
    expect((await call(quoteSync.POST, { token: admin.token, params: { id: q.id } })).json.error.details.dealId).toEqual(['no_items']);
    expect((await call(quoteItem.GET, { token: admin.token, params: { id: q.id } })).json.lines).toHaveLength(1);
  });

  it('并发生成：报价单号不重复且连续 / concurrent creation yields unique numbers', async () => {
    const res = await Promise.all(Array.from({ length: 6 }, () => create(admin)));
    expect(res.map((r) => r.status)).toEqual(Array(6).fill(201));
    const nums = res.map((r) => r.json.quoteNumber as string).sort();
    expect(nums.map((n) => n.slice(-4))).toEqual(['0001', '0002', '0003', '0004', '0005', '0006']);
  });

  it('并发状态变更：只有一个成功，审计只记一次 / concurrent transitions', async () => {
    const q = (await create(admin)).json;
    await setStatus(admin, q.id, 'SENT');
    const res = await Promise.all([setStatus(admin, q.id, 'ACCEPTED'), setStatus(manager, q.id, 'REJECTED')]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { action: 'quote.status', entityId: q.id } })).toBe(2);
  });

  it('审计日志可按报价单筛选 / audit log filter by entity', async () => {
    await create(admin);
    const r = await call(auditLogs.GET, { token: admin.token, query: { entityType: 'quote' } });
    expect(r.status).toBe(200);
    expect(r.json.items.map((x: { action: string }) => x.action)).toEqual(['quote.create']);
  });
});

describe('quotes R2 isolation & input', () => {
  it('跨组织：看不到、改不了、不能用他人商机生成，编号各自从 0001 开始 / cross-org isolation', async () => {
    const q = (await create(admin)).json;
    const other = await createTenant('B', 'ADMIN');
    expect((await call(quoteItem.GET, { token: other.token, params: { id: q.id } })).status).toBe(404);
    expect((await setStatus(other, q.id, 'SENT')).status).toBe(404);
    expect((await call(quotes.GET, { token: other.token })).json.total).toBe(0);
    expect((await create(other)).status).toBe(404);
    const p2 = (await call(products.POST, { token: other.token, body: { sku: 'B', name: 'b', unitPrice: '1' } })).json;
    const d2 = await itemisedDeal(other, p2.id, 'B商机');
    const qb = (await call(quotes.POST, { token: other.token, body: { dealId: d2.id } })).json;
    expect(qb.quoteNumber.slice(-4)).toBe('0001');
    expect(qb.quoteNumber).toBe(q.quoteNumber);
  });

  it.each([
    [{ taxPercent: '100.01' }],
    [{ taxPercent: '-1' }],
    [{ taxPercent: '1.234' }],
    [{ validUntil: '2026-02-30' }],
    [{ validUntil: '31/12/2026' }],
    [{ subject: '   ' }],
    [{ subject: 'x'.repeat(201) }],
    [{ dealId: 'not-a-uuid' }],
    [{ organizationId: '00000000-0000-4000-8000-000000000000' }],
    [{ status: 'SENT' }],
    [{ quoteNumber: 'QT-HACK-1' }],
  ])('非法生成参数 %j → 400 / invalid create input', async (body) => {
    expect((await create(admin, body)).status).toBe(400);
  });

  it('非法修改与状态参数 → 400；未知查询参数与状态 → 400 / invalid update, status and list input', async () => {
    const q = (await create(admin)).json;
    for (const body of [{ total: '1' }, { status: 'SENT' }, { taxPercent: 'abc' }, { createdById: sales1.user.id }]) {
      expect((await call(quoteItem.PATCH, { token: admin.token, method: 'PATCH', params: { id: q.id }, body })).status).toBe(400);
    }
    expect((await setStatus(admin, q.id, 'EXPIRED')).status).toBe(400);
    expect((await call(quotes.GET, { token: admin.token, query: { status: 'OPEN' } })).status).toBe(400);
    expect((await call(quotes.GET, { token: admin.token, query: { dealId: 'x' } })).status).toBe(400);
    expect((await call(quoteItem.GET, { token: admin.token, params: { id: 'x' } })).status).toBe(404);
  });

  it('数据库约束：总计 = 小计 + 税额、税率范围、组织内编号唯一、明细数量 > 0 / DB constraints', async () => {
    const q = (await create(admin)).json;
    await expect(prisma.quote.update({ where: { id: q.id }, data: { total: '1' } })).rejects.toThrow();
    await expect(prisma.quote.update({ where: { id: q.id }, data: { taxPercent: '101' } })).rejects.toThrow();
    const q2 = (await create(admin)).json;
    await expect(prisma.quote.update({ where: { id: q2.id }, data: { quoteNumber: q.quoteNumber } })).rejects.toThrow();
    await expect(prisma.quoteLineItem.updateMany({ where: { quoteId: q.id }, data: { quantity: '0' } })).rejects.toThrow();
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(quotes.GET)).status).toBe(401);
    expect((await call(quotes.POST, { body: { dealId: deal.id } })).status).toBe(401);
  });
});
