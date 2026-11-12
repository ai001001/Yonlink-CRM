/**
 * 销售报表 第二轮：集成测试（角色可见范围、负责人筛选越权、组织隔离、异常参数、与工作台一致、演示数据）。
 * Sales reports round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as dashboard from '@/app/api/dashboard/route';
import * as reports from '@/app/api/reports/sales/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { fixtures } from './fixtures';

type Who = { user: { id: string; name: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let sales1: Who;
let sales2: Who;
let viewer: Who;
const PERIOD = { from: '2026-01-01', to: '2026-06-30' };
const report = (who: { token: string }, query: Record<string, string> = {}) => call(reports.GET, { token: who.token, query: { ...PERIOD, ...query } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  const f = await fixtures(admin.org.id);
  const d1 = await f.deal('PROPOSAL', '100', { ownerId: sales1.user.id });
  await f.deal('CLOSED_WON', '200', { ownerId: sales1.user.id, close: '2026-02-01' });
  const d2 = await f.deal('PROPOSAL', '1000', { ownerId: sales2.user.id });
  await f.deal('CLOSED_WON', '2000', { ownerId: sales2.user.id, close: '2026-02-01' });
  await f.deal('CLOSED_LOST', '5', { ownerId: sales2.user.id, close: '2026-02-01', currency: 'USD' });
  await f.lead('WEBSITE', 'CONVERTED', '2026-02-01T00:00:00Z', sales1.user.id);
  await f.lead('WEBSITE', 'NEW', '2026-02-01T00:00:00Z', sales2.user.id);
  await f.lead('REFERRAL', 'NEW', '2026-02-01T00:00:00Z', sales2.user.id);
  await f.activity(sales1.user.id, '2026-02-01T00:00:00Z');
  await f.activity(sales2.user.id, '2026-02-01T00:00:00Z');
  await f.quote(d1.id, 'ACCEPTED', '100', '2026-02-01T00:00:00Z');
  await f.quote(d2.id, 'REJECTED', '1000', '2026-02-01T00:00:00Z');
});

describe('reports R2 visibility', () => {
  it('销售代表只统计自己负责的数据（各部分）/ sales reps only see their own figures', async () => {
    const r = (await report(sales1)).json;
    expect(r.summary).toMatchObject({ openCount: 1, openAmount: '100.00', wonCount: 1, wonAmount: '200.00', leadTotal: 1, leadConverted: 1, quoteAcceptanceRate: 100 });
    expect(r.owners.map((o: { ownerId: string }) => o.ownerId)).toEqual([sales1.user.id]);
    expect(r.owners[0].activities).toBe(1);
    expect(r.leadSources).toEqual([{ source: 'WEBSITE', total: 1, converted: 1, conversionRate: 100 }]);
    expect(r.currencies).toEqual(['CNY']);
  });

  it('销售代表指定他人为负责人：结果为空，不泄露他人数据 / sales reps cannot query others', async () => {
    const r = (await report(sales1, { ownerId: sales2.user.id })).json;
    expect(r.summary).toMatchObject({ openCount: 0, wonCount: 0, leadTotal: 0, quoteAcceptanceRate: null });
    expect(r.owners).toEqual([]);
    expect(r.quotes.every((q: { count: number }) => q.count === 0)).toBe(true);
  });

  it('只读用户与管理员看到全部，并可按负责人筛选 / read-only and admins see everything', async () => {
    for (const who of [viewer, admin]) {
      const r = (await report(who)).json;
      expect(r.summary).toMatchObject({ openCount: 2, openAmount: '1100.00', wonCount: 2, wonAmount: '2200.00', leadTotal: 3, quoteAcceptanceRate: 50 });
      expect(r.owners.map((o: { name: string }) => o.name)).toEqual([sales2.user.name, sales1.user.name]);
      expect(r.currencies).toEqual(['CNY', 'USD']);
    }
    expect((await report(viewer, { ownerId: sales2.user.id })).json.summary).toMatchObject({ openAmount: '1000.00', leadTotal: 2 });
  });

  it('与工作台进行中商机金额一致 / matches the dashboard open amount', async () => {
    for (const who of [admin, sales1]) {
      const dash = (await call(dashboard.GET, { token: who.token })).json;
      const open = dash.dealAmounts.open.find((s: { currency: string }) => s.currency === 'CNY');
      const r = (await report(who)).json;
      expect(Number(r.summary.openAmount)).toBe(Number(open.amount));
    }
  });
});

describe('reports R2 isolation & input', () => {
  it('跨组织：看不到他组织数据；用他组织用户 ID 筛选结果为空 / cross-org isolation', async () => {
    const other = await createTenant('B', 'ADMIN');
    const r = (await report(other)).json;
    expect(r.summary).toMatchObject({ openCount: 0, wonCount: 0, leadTotal: 0, quoteAcceptanceRate: null });
    expect(r.currencies).toEqual([]);
    expect(r.owners).toEqual([]);
    const leak = (await report(other, { ownerId: sales1.user.id })).json;
    expect(leak.summary).toMatchObject({ openCount: 0, leadTotal: 0 });
  });

  it.each([
    [{ currency: 'GBP' }, undefined],
    [{ from: '2026-02-30' }, undefined],
    [{ to: '2026/06/30' }, undefined],
    [{ from: '2026-07-01', to: '2026-06-30' }, 'from'],
    [{ from: '2024-01-01', to: '2026-01-01' }, 'to'],
    [{ ownerId: 'nobody' }, undefined],
    [{ organizationId: '00000000-0000-4000-8000-000000000000' }, undefined],
    [{ stage: 'CLOSED_WON' }, undefined],
  ])('非法参数 %j → 400 / invalid query', async (query, field) => {
    const res = await report(admin, query as Record<string, string>);
    expect(res.status).toBe(400);
    if (field) expect(Object.keys(res.json.error.details)).toEqual([field]);
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(reports.GET, { query: PERIOD })).status).toBe(401);
  });

  it('演示数据：报表与数据库直接汇总一致 / demo data matches direct aggregates', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const { token } = await addUser(org.id, 'READONLY', 'DEMOVIEW');
    for (const currency of ['CNY', 'USD']) {
      const r = (await call(reports.GET, { token, query: { currency } })).json;
      const open = await prisma.deal.aggregate({ where: { organizationId: org.id, currency, stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST'] } }, _sum: { amount: true }, _count: true });
      expect(r.summary.openAmount).toBe((open._sum.amount ?? 0).toFixed(2));
      expect(r.summary.openCount).toBe(open._count);
      const monthlyWon = r.monthly.reduce((s: number, m: { wonCount: number }) => s + m.wonCount, 0);
      expect(monthlyWon).toBe(r.summary.wonCount);
      expect(r.owners.reduce((s: number, o: { wonCount: number }) => s + o.wonCount, 0)).toBe(r.summary.wonCount);
    }
    const cny = (await call(reports.GET, { token, query: { currency: 'CNY' } })).json;
    expect(cny.summary.wonCount).toBeGreaterThan(0);
    expect(cny.quotes.reduce((s: number, q: { count: number }) => s + q.count, 0)).toBeGreaterThan(0);
  });
});
