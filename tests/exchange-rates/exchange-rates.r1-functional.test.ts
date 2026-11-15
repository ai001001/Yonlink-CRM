/**
 * 汇率 第一轮：功能测试（按日期取有效汇率、录入与同日修改、删除、审计；发票开票日快照、改开票日期重取、汇率变更不影响已开发票；
 * 销售报表与应收账款的本币汇总与缺少汇率提示；演示数据）。
 * Exchange rates round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_RATES } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as rateItem from '@/app/api/exchange-rates/[id]/route';
import * as rates from '@/app/api/exchange-rates/route';
import * as invoiceItem from '@/app/api/invoices/[id]/route';
import * as invoices from '@/app/api/invoices/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as receivables from '@/app/api/reports/receivables/route';
import * as sales from '@/app/api/reports/sales/route';
import * as orders from '@/app/api/sales-orders/route';
import { prisma } from '@/server/db';
import { ratesOn, sumInBase, toBase } from '@/server/modules/exchange-rates';
import { Prisma } from '@/generated/prisma/client';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let seq = 0;
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);
const put = (body: object) => call(rates.PUT, { token: a.token, body, method: 'PUT' });

/** 建一个某币种的订单（单价 100 × 数量）/ an order in a currency (100 × quantity) */
async function order(currency: string, quantity = '10', stage?: string) {
  const ok = async (r: Promise<{ status: number; json: { id: string } }>, status = 201) => {
    const res = await r;
    expect(res.status).toBe(status);
    return res.json;
  };
  seq += 1;
  const p = await ok(call(products.POST, { token: a.token, body: { sku: `P-${seq}`, name: '产品', unitPrice: '100', currency } }));
  const acc = await ok(call(accounts.POST, { token: a.token, body: { name: `客户${seq}` } }));
  const d = await ok(call(deals.POST, { token: a.token, body: { name: `商机${seq}`, accountId: acc.id, currency, ...(stage ? { stage } : {}) } }));
  await ok(call(dealItems.POST, { token: a.token, params: { id: d.id }, body: { productId: p.id, quantity } }));
  const q = await ok(call(quotes.POST, { token: a.token, body: { dealId: d.id } }));
  await ok(call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'SENT' } }), 200);
  await ok(call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'ACCEPTED' } }), 200);
  return ok(call(orders.POST, { token: a.token, body: { quoteId: q.id } }));
}

beforeEach(async () => {
  await resetDb();
  seq = 0;
  a = await createTenant('A');
});

describe('exchange rates R1 rates', () => {
  it('按日期取该日及之前最近生效的汇率；本币为 1 / effective rate by date', async () => {
    await put({ currency: 'USD', rate: '7.1', effectiveDate: '2026-01-01' });
    await put({ currency: 'USD', rate: '7.2', effectiveDate: '2026-06-01' });
    const at = async (d: string) => (await ratesOn(a.org.id, new Date(`${d}T12:00:00Z`))).get('USD')?.toString() ?? null;
    expect(await at('2025-12-31')).toBeNull();
    expect(await at('2026-01-01')).toBe('7.1');
    expect(await at('2026-05-31')).toBe('7.1');
    expect(await at('2026-06-01')).toBe('7.2');
    expect((await ratesOn(a.org.id, new Date())).get('CNY')?.toString()).toBe('1');
    expect(toBase('100.005', new Prisma.Decimal('1')).toString()).toBe('100.01');
    const sum = sumInBase(new Map([['CNY', new Prisma.Decimal(10)], ['USD', new Prisma.Decimal(2)], ['EUR', new Prisma.Decimal(5)], ['JPY', new Prisma.Decimal(0)]]), new Map([['CNY', new Prisma.Decimal(1)], ['USD', new Prisma.Decimal('7.2')]]));
    expect(sum).toEqual({ total: '24.40', missing: ['EUR'] });
  });

  it('录入、同日修改、列表与删除，均写审计 / enter, update, list, delete with audit', async () => {
    const created = await put({ currency: 'EUR', rate: '7.75', effectiveDate: ymd(-5) });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ currency: 'EUR', rate: '7.75', createdBy: { id: a.user.id } });
    const updated = await put({ currency: 'EUR', rate: '7.8', effectiveDate: ymd(-5) });
    expect(updated.json.id).toBe(created.json.id);
    const list = (await call(rates.GET, { token: a.token })).json;
    expect(list.base).toBe('CNY');
    expect(list.current).toEqual([
      { currency: 'USD', rate: null },
      { currency: 'EUR', rate: '7.8' },
      { currency: 'HKD', rate: null },
      { currency: 'JPY', rate: null },
    ]);
    expect(list.history).toHaveLength(1);
    expect((await call(rateItem.DELETE, { token: a.token, params: { id: created.json.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(rates.GET, { token: a.token })).json.history).toEqual([]);
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'rate' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['rate.create', 'rate.update', 'rate.delete']);
    expect(logs[1]!.changes).toEqual({ currency: 'EUR', effectiveDate: ymd(-5), fields: { rate: ['7.75', '7.8'] } });
  });
});

describe('exchange rates R1 invoices', () => {
  it('开票日快照；人民币为 1；无汇率为空；改开票日期重取；汇率变更不影响已开发票 / invoice snapshots', async () => {
    await put({ currency: 'USD', rate: '7.1', effectiveDate: '2026-01-01' });
    await put({ currency: 'USD', rate: '7.2', effectiveDate: '2026-06-01' });
    const usd = await order('USD', '10');
    const inv = (await call(invoices.POST, { token: a.token, body: { salesOrderId: usd.id, invoiceDate: '2026-03-01', dueDate: '2026-12-31' } })).json;
    expect(inv).toMatchObject({ exchangeRate: '7.1', baseTotal: '7100' });
    // 修改开票日期 → 按新日期重取 / changing the invoice date re-takes the snapshot
    const moved = (await call(invoiceItem.PATCH, { token: a.token, params: { id: inv.id }, body: { invoiceDate: '2026-07-01' }, method: 'PATCH' })).json;
    expect(moved).toMatchObject({ exchangeRate: '7.2', baseTotal: '7200' });
    // 汇率变更不影响已开发票 / later rate changes do not touch it
    await put({ currency: 'USD', rate: '9', effectiveDate: '2026-06-01' });
    expect((await call(invoiceItem.GET, { token: a.token, params: { id: inv.id } })).json).toMatchObject({ exchangeRate: '7.2', baseTotal: '7200' });
    const cny = await order('CNY', '3');
    expect((await call(invoices.POST, { token: a.token, body: { salesOrderId: cny.id } })).json).toMatchObject({ exchangeRate: '1', baseTotal: '300' });
    const eur = await order('EUR', '2');
    expect((await call(invoices.POST, { token: a.token, body: { salesOrderId: eur.id } })).json).toMatchObject({ exchangeRate: null, baseTotal: null });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: inv.id, action: 'invoice.update' } });
    expect(log.changes).toMatchObject({ fields: { exchangeRate: ['7.1', '7.2'], baseTotal: ['7100', '7200'] } });
  });
});

describe('exchange rates R1 reports', () => {
  it('销售报表与应收账款的本币汇总；缺少汇率的币种单独列出 / base totals', async () => {
    await put({ currency: 'USD', rate: '7', effectiveDate: ymd(-1) });
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '报表客户' } })).json;
    const deal = (body: object) => call(deals.POST, { token: a.token, body: { accountId: acc.id, expectedCloseDate: ymd(0), ...body } });
    await deal({ name: '人民币在手', amount: '1000', currency: 'CNY', stage: 'NEGOTIATION' });
    await deal({ name: '美元在手', amount: '100', currency: 'USD', stage: 'PROPOSAL' });
    await deal({ name: '欧元在手', amount: '50', currency: 'EUR', stage: 'PROPOSAL' });
    await deal({ name: '美元赢单', amount: '10', currency: 'USD', stage: 'CLOSED_WON' });
    const s = (await call(sales.GET, { token: a.token, query: { currency: 'CNY' } })).json;
    expect(s.base).toEqual({ currency: 'CNY', openAmount: '1700.00', wonAmount: '70.00', missing: ['EUR'] });

    const usd = await order('USD', '1');
    await call(invoices.POST, { token: a.token, body: { salesOrderId: usd.id, invoiceDate: ymd(-40), dueDate: ymd(-10) } });
    const cny = await order('CNY', '5');
    await call(invoices.POST, { token: a.token, body: { salesOrderId: cny.id } });
    const r = (await call(receivables.GET, { token: a.token, query: { currency: 'USD' } })).json;
    // 应收按今天的汇率折算（美元 100 × 7 = 700；人民币 500）/ receivables use today's rate
    expect(r.base).toEqual({ currency: 'CNY', outstanding: '1200.00', overdue: '700.00', missing: [] });
  });
});

describe('exchange rates R1 demo', () => {
  it('演示汇率与发票快照 / demo rates and snapshots', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    expect(await prisma.exchangeRate.count({ where: { organizationId: org.id } })).toBe(DEMO_RATES.length);
    const inv = await prisma.invoice.findMany({ where: { organizationId: org.id } });
    expect(inv.length).toBeGreaterThan(0);
    for (const i of inv) {
      expect(i.exchangeRate).not.toBeNull();
      expect(i.baseTotal!.toString()).toBe(toBase(i.total, i.exchangeRate!).toString());
      const expected = (await ratesOn(org.id, i.invoiceDate)).get(i.currency)!;
      expect(i.exchangeRate!.toString()).toBe(expected.toString());
    }
  });
});
