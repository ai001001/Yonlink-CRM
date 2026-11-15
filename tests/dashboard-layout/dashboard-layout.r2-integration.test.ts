/**
 * 工作台自定义 第二轮：集成测试（布局按用户隔离、同组织其他用户与其他组织不受影响、不能替他人或他组织保存、
 * 只读用户也能自定义、未登录、并发保存只留一条记录、销售看到的即将成交只含自己的商机、跨域预检）。
 * Dashboard customisation round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as layout from '@/app/api/dashboard/layout/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as deals from '@/app/api/deals/route';
import { prisma } from '@/server/db';
import { DASHBOARD_WIDGETS } from '@/server/modules/dashboard-layout';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let sales1: Who;
let sales2: Who;
let viewer: Who;
const save = (who: Who, widgets: unknown, extra: object = {}) => call(layout.PUT, { token: who.token, body: { widgets, ...extra }, method: 'PUT' });
const widgetsOf = async (who: Who) => (await call(layout.GET, { token: who.token })).json.widgets;

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('dashboard layout R2 isolation', () => {
  it('布局按用户隔离 / layouts are per user', async () => {
    await save(sales1, ['closingSoon']);
    await save(other, ['stages', 'counts']);
    expect(await widgetsOf(sales1)).toEqual(['closingSoon']);
    expect(await widgetsOf(sales2)).toEqual([...DASHBOARD_WIDGETS]);
    expect(await widgetsOf(admin)).toEqual([...DASHBOARD_WIDGETS]);
    expect(await widgetsOf(other)).toEqual(['stages', 'counts']);
    // 恢复默认只影响自己 / reset only affects the caller
    await call(layout.DELETE, { token: other.token, method: 'DELETE' });
    expect(await widgetsOf(sales1)).toEqual(['closingSoon']);
    const row = await prisma.userDashboardLayout.findFirstOrThrow();
    expect(row).toMatchObject({ userId: sales1.user.id, organizationId: admin.org.id });
  });

  it('不能替他人或他组织保存；只读用户可自定义；未登录 401 / no saving for others, readonly ok, auth', async () => {
    expect((await save(sales1, ['counts'], { userId: sales2.user.id })).status).toBe(400);
    expect((await save(sales1, ['counts'], { organizationId: other.org.id })).status).toBe(400);
    expect(await prisma.userDashboardLayout.count()).toBe(0);
    expect((await save(viewer, ['myTodos', 'counts'])).status).toBe(200);
    expect((await call(dashboard.GET, { token: viewer.token })).json.layout).toEqual(['myTodos', 'counts']);
    expect((await call(layout.GET)).status).toBe(401);
    expect((await call(layout.PUT, { body: { widgets: ['counts'] }, method: 'PUT' })).status).toBe(401);
    expect((await call(layout.DELETE, { method: 'DELETE' })).status).toBe(401);
    // 保存布局不写审计（个人显示偏好）/ layouts are a personal preference, not audited
    expect(await prisma.auditLog.count({ where: { entityType: 'view' } })).toBe(0);
  });

  it('并发保存只留一条记录，结果为其中之一 / concurrent saves keep one row', async () => {
    const choices = [['counts'], ['stages'], ['myTodos', 'counts'], ['closingSoon'], ['recentActivities']];
    const results = await Promise.all(choices.map((w) => save(admin, w)));
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await prisma.userDashboardLayout.count({ where: { userId: admin.user.id } })).toBe(1);
    expect(choices).toContainEqual(await widgetsOf(admin));
  });

  it('销售看到的即将成交只含自己的商机 / closing soon follows visibility', async () => {
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    for (const [name, owner] of [
      ['销售1商机', sales1],
      ['销售2商机', sales2],
    ] as const) {
      await call(deals.POST, { token: admin.token, body: { name, accountId: acc.id, expectedCloseDate: soon, ownerId: owner.user.id } });
    }
    const mine = (await call(dashboard.GET, { token: sales1.token })).json.closingSoon;
    expect(mine.items.map((d: { name: string }) => d.name)).toEqual(['销售1商机']);
    expect(mine.total).toBe(1);
    expect((await call(dashboard.GET, { token: admin.token })).json.closingSoon.total).toBe(2);
    expect((await call(dashboard.GET, { token: other.token })).json.closingSoon.total).toBe(0);
  });
});

describe('dashboard layout R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET/PUT/DELETE / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await layout.OPTIONS(new Request('http://localhost/api/dashboard/layout', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    for (const m of ['GET', 'PUT', 'DELETE']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
  });
});
