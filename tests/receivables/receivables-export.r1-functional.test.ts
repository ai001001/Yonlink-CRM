/**
 * 应收账款导出 CSV 第一轮：功能测试（内容与报表一致、中英文表头、文件名与响应头、公式注入防护、截断、负责人筛选、审计）。
 * Receivables CSV export round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as payments from '@/app/api/invoices/[id]/payments/route';
import * as invoices from '@/app/api/invoices/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as exportRoute from '@/app/api/reports/receivables/export/route';
import * as report from '@/app/api/reports/receivables/route';
import * as orders from '@/app/api/sales-orders/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { exportReceivables } from '@/server/modules/receivables';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let a: Awaited<ReturnType<typeof createTenant>>;
let seq = 0;
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

/** 建一张发票（单价 100 × 数量），每步断言成功 / create an invoice (100 × quantity), asserting each step */
async function invoice(who: Who, accountName: string, quantity: string, dueIn: number) {
  const ok = async (r: Promise<{ status: number; json: { id: string } }>, status = 201) => {
    const res = await r;
    expect(res.status).toBe(status);
    return res.json;
  };
  seq += 1;
  const p = await ok(call(products.POST, { token: a.token, body: { sku: `P-${seq}`, name: '产品', unitPrice: '100' } }));
  const acc = await ok(call(accounts.POST, { token: who.token, body: { name: accountName } }));
  const d = await ok(call(deals.POST, { token: who.token, body: { name: `商机${seq}`, accountId: acc.id } }));
  await ok(call(dealItems.POST, { token: who.token, params: { id: d.id }, body: { productId: p.id, quantity } }));
  const q = await ok(call(quotes.POST, { token: who.token, body: { dealId: d.id } }));
  await ok(call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'SENT' } }), 200);
  await ok(call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'ACCEPTED' } }), 200);
  const o = await ok(call(orders.POST, { token: who.token, body: { quoteId: q.id } }));
  return ok(call(invoices.POST, { token: who.token, body: { salesOrderId: o.id, invoiceDate: ymd(Math.min(dueIn, 0) - 30), dueDate: ymd(dueIn) } }));
}

/** 调用导出接口并解析 CSV / call the export and parse the CSV */
async function download(token: string, query: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/reports/receivables/export');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await exportRoute.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  const text = await res.text();
  return { res, text, rows: res.status === 200 ? parseCsv(text.replace(/^﻿/, '')) : [] };
}

beforeEach(async () => {
  await resetDb();
  seq = 0;
  a = await createTenant('A');
});

describe('receivables export R1', () => {
  it('内容与报表一致：表头、金额、逾期天数、账龄，按到期日排序 / content matches the report', async () => {
    const i1 = await invoice(a, '甲客户', '10', 10);
    const i2 = await invoice(a, '乙客户', '20', -100);
    await call(payments.POST, { token: a.token, params: { id: i2.id }, body: { amount: '500.50', paidOn: ymd(0), method: 'CASH' } });
    const { res, rows } = await download(a.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="receivables-CNY-${ymd(0).replace(/-/g, '')}.csv"`);
    expect(res.headers.get('X-Export-Count')).toBe('2');
    expect(res.headers.get('X-Export-Truncated')).toBe('false');
    expect(rows[0]).toEqual(['发票号', '客户', '负责人', '币种', '开票日期', '到期日', '发票金额', '已收金额', '未付余额', '逾期天数', '账龄']);
    const inv1 = await prisma.invoice.findUniqueOrThrow({ where: { id: i1.id } });
    const inv2 = await prisma.invoice.findUniqueOrThrow({ where: { id: i2.id } });
    expect(rows.slice(1)).toEqual([
      [inv2.invoiceNumber, '乙客户', a.user.name, 'CNY', ymd(-130), ymd(-100), '2000.00', '500.50', '1499.50', '100', '逾期 90 天以上'],
      [inv1.invoiceNumber, '甲客户', a.user.name, 'CNY', ymd(-30), ymd(10), '1000.00', '0.00', '1000.00', '0', '未到期'],
    ]);
    // 合计与页面报表一致 / totals equal the on-screen report
    const r = (await call(report.GET, { token: a.token })).json;
    const sum = rows.slice(1).reduce((s, row) => s + Math.round(Number(row[8]) * 100), 0);
    expect(sum).toBe(Math.round(Number(r.summary.outstanding) * 100));
  });

  it('英文表头与账龄文字 / English headers and labels', async () => {
    await invoice(a, '甲客户', '1', -45);
    const { rows } = await download(a.token, { lang: 'en-US' });
    expect(rows[0]).toEqual(['Invoice number', 'Account', 'Owner', 'Currency', 'Invoice date', 'Due date', 'Invoice amount', 'Paid', 'Balance due', 'Days overdue', 'Aging']);
    expect(rows[1]![10]).toBe('31–60 days overdue');
  });

  it('公式注入防护：以 = 开头的客户名加前导单引号 / formula injection is neutralised', async () => {
    await invoice(a, '=HYPERLINK("http://x")', '1', 5);
    const { rows } = await download(a.token);
    expect(rows[1]![1]).toBe(`'=HYPERLINK("http://x")`);
  });

  it('币种与负责人筛选；没有数据时只有表头 / filters and empty export', async () => {
    const s = await addUser(a.org.id, 'SALES', 'S');
    await invoice(a, '管理员客户', '1', 5);
    await invoice(s, '销售客户', '2', 5);
    const owned = await download(a.token, { ownerId: s.user.id });
    expect(owned.rows.slice(1).map((r) => r[1])).toEqual(['销售客户']);
    const usd = await download(a.token, { currency: 'USD' });
    expect(usd.rows).toHaveLength(1);
    expect(usd.res.headers.get('X-Export-Count')).toBe('0');
  });

  it('超过上限时截断并告知 / truncation', async () => {
    for (const n of [1, 2, 3]) await invoice(a, `客户${n}`, String(n), -n);
    const ctx = { userId: a.user.id, organizationId: a.org.id, role: 'ADMIN' as const };
    const r = await exportReceivables(ctx, {}, new Date(), 2);
    expect(r).toMatchObject({ count: 2, truncated: true });
    expect(parseCsv(r.csv.replace(/^﻿/, ''))).toHaveLength(3);
  });

  it('导出写审计：只记报表、筛选、行数与是否截断 / export is audited', async () => {
    await invoice(a, '甲客户', '1', 5);
    await download(a.token, { currency: 'CNY', lang: 'en-US' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'invoice.export' } });
    expect(log).toMatchObject({ entityType: 'invoice', entityId: null, actorId: a.user.id });
    expect(log.changes).toEqual({ report: 'receivables', count: 1, truncated: false, filters: { currency: 'CNY' } });
  });
});
