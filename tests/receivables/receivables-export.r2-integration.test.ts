/**
 * 应收账款导出 CSV 第二轮：集成测试（导出权限、可见范围、跨组织隔离、参数校验与未登录、跨域响应头、无权时不写审计）。
 * Receivables CSV export round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as invoices from '@/app/api/invoices/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as exportRoute from '@/app/api/reports/receivables/export/route';
import * as orders from '@/app/api/sales-orders/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales: Who;
let viewer: Who;
let seq = 0;
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

/** 建一张发票，每步断言成功 / create an invoice, asserting each step */
async function invoice(who: Who, accountName: string) {
  const ok = async (r: Promise<{ status: number; json: { id: string } }>, status = 201) => {
    const res = await r;
    expect(res.status).toBe(status);
    return res.json;
  };
  seq += 1;
  const owner = who === other ? other : admin;
  const p = await ok(call(products.POST, { token: owner.token, body: { sku: `P-${seq}`, name: '产品', unitPrice: '100' } }));
  const acc = await ok(call(accounts.POST, { token: who.token, body: { name: accountName } }));
  const d = await ok(call(deals.POST, { token: who.token, body: { name: `商机${seq}`, accountId: acc.id } }));
  await ok(call(dealItems.POST, { token: who.token, params: { id: d.id }, body: { productId: p.id, quantity: '1' } }));
  const q = await ok(call(quotes.POST, { token: who.token, body: { dealId: d.id } }));
  await ok(call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'SENT' } }), 200);
  await ok(call(quoteStatus.POST, { token: who.token, params: { id: q.id }, body: { status: 'ACCEPTED' } }), 200);
  const o = await ok(call(orders.POST, { token: who.token, body: { quoteId: q.id } }));
  return ok(call(invoices.POST, { token: who.token, body: { salesOrderId: o.id, dueDate: ymd(30) } }));
}

/** 调用导出接口 / call the export */
async function download(token: string | undefined, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/reports/receivables/export');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await exportRoute.GET(new Request(url, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }), { params: Promise.resolve({}) });
  const text = await res.text();
  return { res, rows: res.status === 200 ? parseCsv(text.replace(/^﻿/, '')) : [] };
}

beforeEach(async () => {
  await resetDb();
  seq = 0;
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('receivables export R2', () => {
  it('只有管理员与经理能导出；销售与只读 403 且不写审计 / export permission', async () => {
    await invoice(sales, '销售客户');
    await invoice(admin, '管理员客户');
    for (const who of [sales, viewer]) {
      expect((await download(who.token)).res.status).toBe(403);
      expect((await download(who.token, { ownerId: who.user.id })).res.status).toBe(403);
    }
    expect(await prisma.auditLog.count({ where: { action: 'invoice.export' } })).toBe(0);
    for (const who of [admin, manager]) {
      const { res, rows } = await download(who.token);
      expect(res.status).toBe(200);
      expect(rows.slice(1).map((r) => r[1]).sort()).toEqual(['管理员客户', '销售客户']);
    }
    expect(await prisma.auditLog.count({ where: { action: 'invoice.export' } })).toBe(2);
  });

  it('跨组织：只导出本组织；用对方负责人筛选得到空表 / cross-tenant isolation', async () => {
    await invoice(admin, '甲组织客户');
    await invoice(other, '乙组织客户');
    expect((await download(other.token)).rows.slice(1).map((r) => r[1])).toEqual(['乙组织客户']);
    const sneaky = await download(other.token, { ownerId: admin.user.id });
    expect(sneaky.res.status).toBe(200);
    expect(sneaky.rows).toHaveLength(1);
  });

  it('参数校验与未登录 / validation and auth', async () => {
    for (const query of [{ currency: 'XXX' }, { ownerId: 'x' }, { lang: 'fr-FR' }, { status: 'PAID' }] as Record<string, string>[]) {
      expect((await download(admin.token, query)).res.status).toBe(400);
    }
    expect((await download(undefined)).res.status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'invoice.export' } })).toBe(0);
  });
});

describe('receivables export R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域时前端能读取文件名与导出行数 / exposed headers for the cross-origin frontend', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    await invoice(admin, '甲客户');
    const { res } = await download(admin.token, {}, { Origin: 'https://ai001001.github.io' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    const exposed = res.headers.get('Access-Control-Expose-Headers') ?? '';
    for (const h of ['Content-Disposition', 'X-Export-Count', 'X-Export-Truncated']) expect(exposed).toContain(h);
    const pre = await exportRoute.OPTIONS(new Request('http://localhost/api/reports/receivables/export', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});
