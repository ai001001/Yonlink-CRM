/**
 * 应收账款报表 第一轮：功能测试（逾期天数与账龄分段、未收与逾期汇总、部分付款、作废与付清不计、按客户汇总与排序、
 * 发票明细、近 30 天收款、币种分开统计、演示数据）。
 * Receivables round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
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
import { prisma } from '@/server/db';
import { agingBucket, daysOverdue } from '@/server/modules/receivables';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let product: { id: string };
/** 同名客户复用同一条记录 / same-name invoices share one account */
const accountIds = new Map<string, string>();
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

/**
 * 建一张发票：客户、商机（单价 100 × 数量）、报价、订单、发票；到期日为今天加偏移天数。
 * Create an invoice (100 × quantity) due `dueIn` days from today.
 */
async function invoice(accountName: string, quantity: string, dueIn: number, currency = 'CNY') {
  if (!accountIds.has(accountName)) accountIds.set(accountName, (await call(accounts.POST, { token: a.token, body: { name: accountName } })).json.id);
  const d = (await call(deals.POST, { token: a.token, body: { name: `${accountName}商机${quantity}${dueIn}`, accountId: accountIds.get(accountName), currency } })).json;
  const p = currency === 'CNY' ? product : (await call(products.POST, { token: a.token, body: { sku: `P-${currency}`, name: '外币产品', unitPrice: '100', currency } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: d.id }, body: { productId: p.id, quantity } });
  const q = (await call(quotes.POST, { token: a.token, body: { dealId: d.id } })).json;
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  const o = (await call(orders.POST, { token: a.token, body: { quoteId: q.id } })).json;
  const res = await call(invoices.POST, { token: a.token, body: { salesOrderId: o.id, invoiceDate: ymd(Math.min(dueIn, 0) - 30), dueDate: ymd(dueIn) } });
  expect(res.status).toBe(201);
  return res.json as { id: string; invoiceNumber: string; account: unknown };
}
const pay = (id: string, amount: string, paidOn = ymd(0)) => call(payments.POST, { token: a.token, params: { id }, body: { amount, paidOn, method: 'CASH' } });
const get = async (query: Record<string, string> = {}) => {
  const r = await call(report.GET, { token: a.token, query });
  expect(r.status).toBe(200);
  return r.json;
};

beforeEach(async () => {
  await resetDb();
  accountIds.clear();
  a = await createTenant('A');
  product = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品', unitPrice: '100' } })).json;
});

describe('receivables R1 aging', () => {
  it('逾期天数与账龄分段边界 / bucket boundaries', () => {
    const today = new Date('2026-11-14T00:00:00Z');
    expect(daysOverdue(new Date('2026-11-14T00:00:00Z'), today)).toBe(0);
    expect(daysOverdue(new Date('2026-11-13T00:00:00Z'), today)).toBe(1);
    expect(daysOverdue(new Date('2026-12-01T00:00:00Z'), today)).toBe(-17);
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91, 400].map(agingBucket)).toEqual([
      'current', 'current', 'd1_30', 'd1_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90_plus', 'd90_plus',
    ]);
  });

  it('未收、逾期、账龄、按客户汇总与发票明细 / totals, aging, accounts and invoices', async () => {
    const i1 = await invoice('甲客户', '10', 10); // 1000 未到期 / current
    const i2 = await invoice('甲客户', '5', -45); // 500 逾期 45 天 / 45 days overdue
    const i3 = await invoice('乙客户', '20', -100); // 2000 逾期 100 天 / 100 days overdue
    await pay(i3.id, '500.50');
    const r = await get();
    expect(r.summary).toMatchObject({ outstanding: '2999.50', outstandingCount: 3, overdue: '1999.50', overdueCount: 2 });
    expect(r.buckets).toEqual([
      { bucket: 'current', count: 1, amount: '1000.00' },
      { bucket: 'd1_30', count: 0, amount: '0.00' },
      { bucket: 'd31_60', count: 1, amount: '500.00' },
      { bucket: 'd61_90', count: 0, amount: '0.00' },
      { bucket: 'd90_plus', count: 1, amount: '1499.50' },
    ]);
    // 欠款多的客户在前 / largest balance first
    expect(r.accounts.map((x: { name: string }) => x.name)).toEqual(['甲客户', '乙客户']);
    expect(r.accounts[0]).toMatchObject({ count: 2, outstanding: '1500.00', maxDaysOverdue: 45, oldestDueDate: ymd(-45) });
    expect(r.accounts[0].buckets).toMatchObject({ current: '1000.00', d31_60: '500.00', d90_plus: '0.00' });
    expect(r.accounts[1]).toMatchObject({ count: 1, outstanding: '1499.50', maxDaysOverdue: 100 });
    // 明细按到期日升序 / invoices by due date
    expect(r.invoices.map((x: { id: string }) => x.id)).toEqual([i3.id, i2.id, i1.id]);
    expect(r.invoices[0]).toMatchObject({ total: '2000.00', balance: '1499.50', daysOverdue: 100, bucket: 'd90_plus', account: { name: '乙客户' } });
    expect(r.invoices[2]).toMatchObject({ daysOverdue: 0, bucket: 'current' });
    expect(r.truncated).toBe(false);
    expect(r.asOf).toBe(ymd(0));
  });

  it('已付清、已作废不计入；近 30 天收款按收款日期统计 / paid and void excluded; collections', async () => {
    const paid = await invoice('丙客户', '1', -5);
    await pay(paid.id, '60', ymd(-40));
    await pay(paid.id, '40', ymd(-29));
    const voided = await invoice('丁客户', '3', -5);
    await call(voidRoute.POST, { token: a.token, params: { id: voided.id }, body: {} });
    const open = await invoice('戊客户', '2', 3);
    await pay(open.id, '50');
    const r = await get();
    expect(r.summary).toMatchObject({ outstanding: '150.00', outstandingCount: 1, overdue: '0.00', overdueCount: 0, collected: '90.00', collectedCount: 2 });
    expect(r.accounts.map((x: { name: string }) => x.name)).toEqual(['戊客户']);
  });

  it('各币种分别统计，并列出有未收发票的币种 / per currency', async () => {
    await invoice('甲客户', '1', -1);
    await invoice('美元客户', '7', -1, 'USD');
    const cny = await get();
    expect(cny.summary.outstanding).toBe('100.00');
    expect(cny.currencies).toEqual(['CNY', 'USD']);
    const usd = await get({ currency: 'USD' });
    expect(usd).toMatchObject({ currency: 'USD', summary: { outstandingCount: 1 } });
    expect(usd.accounts.map((x: { name: string }) => x.name)).toEqual(['美元客户']);
    expect(cny.accounts.map((x: { name: string }) => x.name)).toEqual(['甲客户']);
    const eur = await get({ currency: 'EUR' });
    expect(eur.summary).toMatchObject({ outstanding: '0.00', outstandingCount: 0 });
    expect(eur.accounts).toEqual([]);
  });
});

describe('receivables R1 demo', () => {
  it('演示数据：未收发票与账龄 / demo receivables', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const admin = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'ADMIN' } });
    const { hashToken } = await import('@/server/auth');
    const token = 'demo-receivables-token-' + Date.now();
    await prisma.session.create({ data: { userId: admin.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
    const open = await prisma.invoice.findMany({ where: { organizationId: org.id, status: { in: ['UNPAID', 'PARTIALLY_PAID'] } } });
    const currency = open[0]!.currency;
    const r = (await call(report.GET, { token, query: { currency } })).json;
    const expected = open.filter((i) => i.currency === currency).reduce((s, i) => s + Math.round((Number(i.total) - Number(i.paidAmount)) * 100), 0);
    expect(Math.round(Number(r.summary.outstanding) * 100)).toBe(expected);
    expect(r.summary.overdueCount).toBeGreaterThan(0);
    expect(r.buckets.reduce((s: number, b: { count: number }) => s + b.count, 0)).toBe(r.summary.outstandingCount);
  });
});
