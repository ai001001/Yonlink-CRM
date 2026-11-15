/**
 * 报表导出 第二轮：集成测试（导出权限、可见范围、跨组织隔离、参数校验与未登录、非法时间段不写审计、跨域响应头）。
 * Report exports round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as deals from '@/app/api/deals/route';
import * as forecastExport from '@/app/api/forecasts/export/route';
import * as salesExport from '@/app/api/reports/sales/export/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Route = { GET: (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response> };
type Who = { user: { id: string; name: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales: Who;
let viewer: Who;
const today = new Date().toISOString().slice(0, 10);
const routes: [string, Route, string][] = [
  ['sales', salesExport, '/api/reports/sales/export'],
  ['forecast', forecastExport, '/api/forecasts/export'],
];

async function download(route: Route, path: string, token: string | undefined, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await route.GET(new Request(url, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }), { params: Promise.resolve({}) });
  const text = (await res.text()).replace(/^﻿/, '');
  return { res, text, rows: res.status === 200 ? parseCsv(text) : [] };
}

/** 以某人身份建一个赢单商机 / a won deal owned by someone */
async function wonDeal(who: Who, name: string) {
  const acc = (await call(accounts.POST, { token: who.token, body: { name: `${name}客户` } })).json;
  const r = await call(deals.POST, { token: who.token, body: { name, accountId: acc.id, amount: '100', stage: 'CLOSED_WON', expectedCloseDate: today } });
  expect(r.status).toBe(201);
}

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('report exports R2', () => {
  it('只有管理员与经理能导出；销售与只读 403 且不写审计 / export permission', async () => {
    for (const [, route, path] of routes) {
      for (const who of [sales, viewer]) expect((await download(route, path, who.token)).res.status).toBe(403);
      for (const who of [admin, manager]) expect((await download(route, path, who.token)).res.status).toBe(200);
    }
    expect(await prisma.auditLog.count({ where: { action: 'report.export' } })).toBe(4);
  });

  it('经理导出包含全体负责人；跨组织只含本组织 / scope and isolation', async () => {
    await wonDeal(sales, '销售赢单');
    await wonDeal(admin, '管理员赢单');
    await wonDeal(other, '乙组织赢单');
    const mine = await download(salesExport, '/api/reports/sales/export', manager.token);
    expect(mine.text).toContain(sales.user.name);
    expect(mine.text).toContain(admin.user.name);
    expect(mine.text).not.toContain(other.user.name);
    const theirs = await download(forecastExport, '/api/forecasts/export', other.token);
    expect(theirs.text).toContain(other.user.name);
    expect(theirs.text).not.toContain(sales.user.name);
    expect(theirs.text).not.toContain(admin.user.name);
    // 用对方组织的负责人筛选得到空排行 / filtering by another org's owner yields nothing of theirs
    const sneaky = await download(salesExport, '/api/reports/sales/export', other.token, { ownerId: admin.user.id });
    expect(sneaky.res.status).toBe(200);
    expect(sneaky.text).not.toContain(admin.user.name);
    expect(sneaky.text).not.toContain('100.00');
  });

  it('参数校验与未登录，均不写审计 / validation and auth', async () => {
    const bad: [Route, string, Record<string, string>][] = [
      [salesExport, '/api/reports/sales/export', { currency: 'XXX' }],
      [salesExport, '/api/reports/sales/export', { from: '2026-05-01', to: '2026-01-01' }],
      [salesExport, '/api/reports/sales/export', { from: '2023-01-01', to: '2026-01-01' }],
      [salesExport, '/api/reports/sales/export', { lang: 'de-DE' }],
      [salesExport, '/api/reports/sales/export', { foo: '1' }],
      [forecastExport, '/api/forecasts/export', { period: '2026-13' }],
      [forecastExport, '/api/forecasts/export', { ownerId: admin.user.id }],
      [forecastExport, '/api/forecasts/export', { lang: 'xx' }],
    ];
    for (const [route, path, query] of bad) expect((await download(route, path, admin.token, query)).res.status).toBe(400);
    for (const [, route, path] of routes) expect((await download(route, path, undefined)).res.status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'report.export' } })).toBe(0);
  });
});

describe('report exports R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域时前端能读取文件名与行数 / exposed headers', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    for (const [, route, path] of routes) {
      const { res } = await download(route, path, admin.token, {}, { Origin: 'https://ai001001.github.io' });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
      for (const h of ['Content-Disposition', 'X-Export-Count']) expect(res.headers.get('Access-Control-Expose-Headers')).toContain(h);
    }
  });
});
