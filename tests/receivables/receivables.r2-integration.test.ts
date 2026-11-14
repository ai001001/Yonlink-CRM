/**
 * 应收账款报表 第二轮：集成测试（销售代表只统计自己的、负责人筛选不能越权、只读与经理看全部、跨组织隔离、
 * 参数校验与未登录、明细截断、随时间推移的账龄变化、收款与作废实时生效、跨域预检）。
 * Receivables round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as payments from '@/app/api/invoices/[id]/payments/route';
import * as voidRoute from '@/app/api/invoices/[id]/void/route';
import * as invoices from '@/app/api/invoices/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as report from '@/app/api/reports/receivables/route';
import * as orders from '@/app/api/sales-orders/route';
import { receivablesReport } from '@/server/modules/receivables';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

/** 产品编码序号 / product SKU counter */
let seq = 0;

/**
 * 以某人身份建一张发票（单价 100 × 数量）；每一步都断言成功，出错时直接定位到那一步。
 * Create an invoice as someone (100 × quantity); every step asserts success so a failure points at its step.
 */
async function invoice(who: Who, name: string, quantity: string, dueIn: number) {
  const ok = async (r: Promise<{ status: number; json: { id: string } }>, status = 201) => {
    const res = await r;
    expect(res.status).toBe(status);
    return res.json;
  };
  seq += 1;
  const p = await ok(call(products.POST, { token: admin.token, body: { sku: `P-${seq}`, name: '产品', unitPrice: '100' } }));
  const acc = await ok(call(accounts.POST, { token: who.token, body: { name } }));
  const d = await ok(call(deals.POST, { token: who.token, body: { name: `${name}商机`, accountId: acc.id } }));
  await ok(call(dealItems.POST, { token: who.token, params: { id: d.id }, body: { productId: p.id, quantity } }));
  const q = await ok(call(quotes.POST, { token: who.token, body: { dealId: d.id } }));
  await ok(call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'SENT' } }), 200);
  await ok(call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'ACCEPTED' } }), 200);
  const o = await ok(call(orders.POST, { token: who.token, body: { quoteId: q.id } }));
  return ok(call(invoices.POST, { token: who.token, body: { salesOrderId: o.id, invoiceDate: ymd(Math.min(dueIn, 0) - 30), dueDate: ymd(dueIn) } }));
}
const get = async (who: Who, query: Record<string, string> = {}) => (await call(report.GET, { token: who.token, query })).json;
const names = (r: { accounts: { name: string }[] }) => r.accounts.map((x) => x.name).sort();

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('receivables R2 scope', () => {
  it('销售代表只统计自己的；传别人的负责人也不能越权 / sales reps see only their own', async () => {
    await invoice(sales1, '销售1客户', '1', -10);
    await invoice(sales2, '销售2客户', '2', -10);
    const s1 = await get(sales1);
    expect(names(s1)).toEqual(['销售1客户']);
    expect(s1.summary).toMatchObject({ outstanding: '100.00', overdueCount: 1 });
    const sneaky = await get(sales1, { ownerId: sales2.user.id });
    expect(sneaky.accounts).toEqual([]);
    expect(sneaky.summary.outstanding).toBe('0.00');
    for (const who of [viewer, manager, admin]) expect(names(await get(who))).toEqual(['销售1客户', '销售2客户']);
    expect(names(await get(manager, { ownerId: sales2.user.id }))).toEqual(['销售2客户']);
  });

  it('销售代表的近 30 天收款也只统计自己的 / collections follow the scope', async () => {
    const i1 = await invoice(sales1, '销售1客户', '1', 5);
    const i2 = await invoice(sales2, '销售2客户', '1', 5);
    await call(payments.POST, { token: sales1.token, params: { id: i1.id }, body: { amount: '30', paidOn: ymd(0), method: 'CASH' } });
    await call(payments.POST, { token: sales2.token, params: { id: i2.id }, body: { amount: '40', paidOn: ymd(0), method: 'CASH' } });
    expect((await get(sales1)).summary).toMatchObject({ collected: '30.00', collectedCount: 1 });
    expect((await get(admin)).summary).toMatchObject({ collected: '70.00', collectedCount: 2 });
  });

  it('跨组织数据互不可见 / cross-tenant isolation', async () => {
    const i = await invoice(admin, '甲组织客户', '3', -1);
    await call(payments.POST, { token: admin.token, params: { id: i.id }, body: { amount: '10', paidOn: ymd(0), method: 'CASH' } });
    const r = await get(other);
    expect(r).toMatchObject({ summary: { outstanding: '0.00', outstandingCount: 0, collected: '0.00' }, accounts: [], invoices: [], currencies: [] });
    expect((await get(other, { ownerId: admin.user.id })).accounts).toEqual([]);
  });

  it('参数校验与未登录 / validation and auth', async () => {
    for (const query of [{ currency: 'XXX' }, { ownerId: 'x' }, { from: '2026-01-01' }] as Record<string, string>[]) {
      expect((await call(report.GET, { token: admin.token, query })).status).toBe(400);
    }
    expect((await call(report.GET)).status).toBe(401);
  });
});

describe('receivables R2 behaviour', () => {
  it('明细超过上限时截断，汇总仍包含全部 / truncated list keeps full totals', async () => {
    for (const n of [1, 2, 3]) await invoice(admin, `客户${n}`, String(n), -n);
    const ctx = { userId: admin.user.id, organizationId: admin.org.id, role: 'ADMIN' as const };
    const r = await receivablesReport(ctx, { currency: 'CNY' }, new Date(), 2);
    expect(r.truncated).toBe(true);
    expect(r.invoices).toHaveLength(2);
    expect(r.summary).toMatchObject({ outstanding: '600.00', outstandingCount: 3 });
    expect(r.accounts).toHaveLength(3);
  });

  it('时间推移后账龄随之变化 / aging moves with time', async () => {
    await invoice(admin, '甲客户', '1', 0);
    const ctx = { userId: admin.user.id, organizationId: admin.org.id, role: 'ADMIN' as const };
    const at = (days: number) => receivablesReport(ctx, { currency: 'CNY' }, new Date(Date.now() + days * 86400_000));
    const bucketOf = async (days: number) => (await at(days)).invoices[0]!.bucket;
    expect(await bucketOf(0)).toBe('current');
    expect(await bucketOf(1)).toBe('d1_30');
    expect(await bucketOf(31)).toBe('d31_60');
    expect(await bucketOf(61)).toBe('d61_90');
    expect(await bucketOf(91)).toBe('d90_plus');
    expect((await at(91)).summary.overdue).toBe('100.00');
  });

  it('收款与作废实时生效 / payments and voids apply immediately', async () => {
    const i = await invoice(admin, '甲客户', '4', -3);
    expect((await get(admin)).summary.outstanding).toBe('400.00');
    await call(payments.POST, { token: admin.token, params: { id: i.id }, body: { amount: '400', paidOn: ymd(0), method: 'CASH' } });
    expect((await get(admin)).summary).toMatchObject({ outstanding: '0.00', collected: '400.00' });
    const j = await invoice(admin, '乙客户', '2', 3);
    expect((await get(admin)).summary.outstanding).toBe('200.00');
    await call(voidRoute.POST, { token: admin.token, params: { id: j.id }, body: {} });
    expect((await get(admin)).summary.outstanding).toBe('0.00');
  });
});

describe('receivables R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await report.OPTIONS(new Request('http://localhost/api/reports/receivables', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});
