/**
 * 工单导出 CSV 第二轮：集成测试（需导出权限：管理员、经理可导出，销售与只读 403 且不写审计；经理导出全部、
 * 跨组织隔离；非法参数 400；未登录 401；超过上限截断；跨域预检暴露导出头）。
 * Ticket CSV export round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as ticketExport from '@/app/api/tickets/export/route';
import * as tickets from '@/app/api/tickets/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { EXPORT_MAX } from '@/server/modules/import-export';
import { addUser, createTenant, call, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let viewer: Who;

/** 调用导出 / call the export */
async function download(who: Who | null, query: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/tickets/export');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = who ? { authorization: `Bearer ${who.token}` } : {};
  const res = await ticketExport.GET(new Request(url, { headers }), { params: Promise.resolve({}) });
  const rows = res.status === 200 ? parseCsv((await res.text()).replace(/^﻿/, '')) : [];
  return { res, rows };
}

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
  const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户', ownerId: sales1.user.id } })).json;
  await call(tickets.POST, { token: admin.token, body: { subject: '销售的', accountId: acc.id, ownerId: sales1.user.id } });
  await call(tickets.POST, { token: admin.token, body: { subject: '管理员的', accountId: acc.id } });
});

describe('ticket export R2', () => {
  it('权限：经理可导出全部；销售、只读 403 且不写审计 / permissions', async () => {
    const m = await download(manager);
    expect(m.res.status).toBe(200);
    expect(m.rows.slice(1).map((r) => r[1]).sort()).toEqual(['销售的', '管理员的'].sort());
    for (const who of [sales1, viewer]) {
      const r = await download(who);
      expect(r.res.status).toBe(403);
    }
    expect(await prisma.auditLog.count({ where: { action: 'ticket.export' } })).toBe(1);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.export' } })).actorId).toBe(manager.user.id);
  });

  it('跨组织隔离；非法参数；未登录 / isolation, validation, auth', async () => {
    const o = await download(other);
    expect(o.res.status).toBe(200);
    expect(o.rows).toHaveLength(1);
    expect(o.res.headers.get('X-Export-Count')).toBe('0');
    for (const query of [{ status: 'DONE' }, { priority: 'P0' }, { overdue: 'yes' }, { ownerId: 'x' }, { lang: 'fr-FR' }] as Record<string, string>[]) {
      expect((await download(admin, query)).res.status).toBe(400);
    }
    expect((await download(null)).res.status).toBe(401);
  });

  it('超过上限时截断并标记 / truncation at the cap', async () => {
    const acc = await prisma.account.findFirstOrThrow({ where: { organizationId: admin.org.id } });
    const year = new Date().getUTCFullYear();
    await prisma.ticket.createMany({
      data: Array.from({ length: EXPORT_MAX }, (_, i) => ({ organizationId: admin.org.id, accountId: acc.id, ticketNumber: `CS-${year}-B${String(i).padStart(5, '0')}`, subject: `批量${i}` })),
    });
    const r = await download(admin);
    expect(r.res.headers.get('X-Export-Count')).toBe(String(EXPORT_MAX));
    expect(r.res.headers.get('X-Export-Truncated')).toBe('true');
    expect(r.rows).toHaveLength(EXPORT_MAX + 1);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.export' } })).changes).toMatchObject({ count: EXPORT_MAX, truncated: true });
  }, 60_000);
});

describe('ticket export R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检与导出头暴露 / preflight and exposed headers', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const pre = await ticketExport.OPTIONS(new Request('http://localhost/api/tickets/export', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    const url = new URL('http://localhost/api/tickets/export');
    const res = await ticketExport.GET(new Request(url, { headers: { authorization: `Bearer ${admin.token}`, Origin: 'https://ai001001.github.io' } }), { params: Promise.resolve({}) });
    const exposed = res.headers.get('Access-Control-Expose-Headers') ?? '';
    for (const h of ['Content-Disposition', 'X-Export-Count', 'X-Export-Truncated']) expect(exposed).toContain(h);
  });
});
