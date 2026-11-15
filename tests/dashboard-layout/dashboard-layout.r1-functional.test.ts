/**
 * 工作台自定义 第一轮：功能测试（默认布局、保存顺序与隐藏、隐藏卡片不计算、恢复默认、已下线的键被忽略、
 * 参数校验；即将成交：含已逾期的进行中商机、排除超出 30 天、已关闭与无日期的商机，按日期排序并计数；演示重置清空布局）。
 * Dashboard customisation round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as layout from '@/app/api/dashboard/layout/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as deals from '@/app/api/deals/route';
import { prisma } from '@/server/db';
import { DASHBOARD_WIDGETS } from '@/server/modules/dashboard-layout';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const save = (widgets: unknown) => call(layout.PUT, { token: a.token, body: { widgets }, method: 'PUT' });
const board = async () => (await call(dashboard.GET, { token: a.token })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('dashboard layout R1', () => {
  it('默认布局显示全部卡片 / default layout shows every card', async () => {
    expect((await call(layout.GET, { token: a.token })).json).toEqual({ widgets: [...DASHBOARD_WIDGETS], isDefault: true });
    const d = await board();
    expect(d.layout).toEqual([...DASHBOARD_WIDGETS]);
    expect(d.counts).toEqual({ accounts: 0, leads: 0, deals: 0 });
    expect(d.dealAmounts).toEqual({ all: [], open: [], won: [] });
    expect(d.myTodos).toEqual([]);
    expect(d.myTodoCount).toBe(0);
    expect(d.recentActivities).toEqual([]);
    expect(d.stages).toEqual([]);
    expect(d.closingSoon).toEqual({ items: [], total: 0, days: 30 });
  });

  it('保存顺序与隐藏；隐藏的卡片不计算；恢复默认 / save, hidden cards skipped, reset', async () => {
    const r = await save(['stages', 'closingSoon', 'counts']);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ widgets: ['stages', 'closingSoon', 'counts'], isDefault: false });
    expect((await call(layout.GET, { token: a.token })).json).toEqual({ widgets: ['stages', 'closingSoon', 'counts'], isDefault: false });
    const d = await board();
    expect(d.layout).toEqual(['stages', 'closingSoon', 'counts']);
    expect(d.counts).not.toBeNull();
    expect(d.stages).toEqual([]);
    expect(d.dealAmounts).toBeNull();
    expect(d.myTodos).toBeNull();
    expect(d.myTodoCount).toBeNull();
    expect(d.myOverdueCount).toBeNull();
    expect(d.recentActivities).toBeNull();
    // 再次保存覆盖 / saving again overwrites
    await save(['myTodos']);
    expect((await board()).layout).toEqual(['myTodos']);
    expect(await prisma.userDashboardLayout.count()).toBe(1);
    const reset = await call(layout.DELETE, { token: a.token, method: 'DELETE' });
    expect(reset.json).toEqual({ widgets: [...DASHBOARD_WIDGETS], isDefault: true });
    expect(await prisma.userDashboardLayout.count()).toBe(0);
    expect((await board()).layout).toEqual([...DASHBOARD_WIDGETS]);
  });

  it('已下线的卡片键被忽略；全部失效时用默认 / retired keys are ignored', async () => {
    await prisma.userDashboardLayout.create({ data: { organizationId: a.org.id, userId: a.user.id, widgets: ['oldChart', 'stages', 'stages', 'counts'] } });
    expect((await call(layout.GET, { token: a.token })).json).toEqual({ widgets: ['stages', 'counts'], isDefault: false });
    await prisma.userDashboardLayout.update({ where: { userId: a.user.id }, data: { widgets: ['oldChart'] } });
    expect((await call(layout.GET, { token: a.token })).json).toEqual({ widgets: [...DASHBOARD_WIDGETS], isDefault: true });
  });

  it('参数校验 / validation', async () => {
    for (const widgets of [[], ['counts', 'counts'], ['counts', 'weather'], 'counts', null, [...DASHBOARD_WIDGETS, 'counts']]) {
      expect((await save(widgets)).status).toBe(400);
    }
    expect((await call(layout.PUT, { token: a.token, body: {}, method: 'PUT' })).status).toBe(400);
    expect(await prisma.userDashboardLayout.count()).toBe(0);
  });
});

describe('dashboard closing soon R1', () => {
  it('即将成交：含逾期、排除 30 天外、已关闭、无日期；按日期排序 / closing soon', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const mk = (name: string, extra: object) => call(deals.POST, { token: a.token, body: { name, accountId: acc.id, amount: '100', ...extra } });
    await mk('逾期商机', { expectedCloseDate: day(-5), stage: 'NEGOTIATION' });
    await mk('十天后', { expectedCloseDate: day(10) });
    await mk('今天', { expectedCloseDate: day(0), currency: 'USD', amount: '50' });
    await mk('第三十天', { expectedCloseDate: day(30) });
    await mk('四十天后', { expectedCloseDate: day(40) });
    await mk('已赢单', { expectedCloseDate: day(3), stage: 'CLOSED_WON' });
    await mk('已输单', { expectedCloseDate: day(3), stage: 'CLOSED_LOST' });
    await mk('无日期', {});
    const soon = (await board()).closingSoon;
    expect(soon.total).toBe(4);
    expect(soon.items.map((d: { name: string }) => d.name)).toEqual(['逾期商机', '今天', '十天后', '第三十天']);
    expect(soon.items[1]).toMatchObject({ amount: '50', currency: 'USD', account: { name: '客户' }, owner: { id: a.user.id } });
    // 最多列出 10 条，总数照常 / at most 10 listed, total still counted
    for (let i = 0; i < 9; i++) await mk(`批量${i}`, { expectedCloseDate: day(20) });
    const many = (await board()).closingSoon;
    expect(many.total).toBe(13);
    expect(many.items).toHaveLength(10);
  });

  it('演示重置清空演示账号的布局 / demo reset clears layouts', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const user = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id } });
    await prisma.userDashboardLayout.create({ data: { organizationId: org.id, userId: user.id, widgets: ['counts'] } });
    await seedDemo({ reset: true });
    expect(await prisma.userDashboardLayout.count({ where: { organizationId: org.id } })).toBe(0);
  });
});
