/**
 * 销售目标与预测 第一轮：功能测试（期间解析、每行各指标精确值、季度与合计、参与统计的用户、目标设定/修改/清除与审计、演示数据）。
 * Sales targets and forecast round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_TARGETS, DEMO_USERS, demoTargetAmount } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as forecasts from '@/app/api/forecasts/route';
import * as targets from '@/app/api/forecasts/targets/route';
import { prisma } from '@/server/db';
import { resolveForecastPeriod } from '@/server/modules/forecasts';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { fixtures } from '../reports/fixtures';

let a: Awaited<ReturnType<typeof createTenant>>;
let f: Awaited<ReturnType<typeof fixtures>>;
const get = async (query: Record<string, string>, token = a.token) => {
  const r = await call(forecasts.GET, { token, query });
  expect(r.status).toBe(200);
  return r.json;
};
const setTarget = (body: object, token = a.token) => call(targets.PUT, { token, method: 'PUT', body: { currency: 'CNY', ...body } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  f = await fixtures(a.org.id);
});

describe('forecasts R1 period', () => {
  it('期间：月、季度、缺省为当前月；非法期间抛错 / period parsing', () => {
    const m = resolveForecastPeriod('2026-11');
    expect([m.kind, m.months.map((d) => d.toISOString().slice(0, 10)), m.endExclusive.toISOString().slice(0, 10)]).toEqual(['month', ['2026-11-01'], '2026-12-01']);
    const q = resolveForecastPeriod('2026-Q4');
    expect([q.kind, q.months.map((d) => d.toISOString().slice(0, 7)), q.endExclusive.toISOString().slice(0, 10)]).toEqual(['quarter', ['2026-10', '2026-11', '2026-12'], '2027-01-01']);
    expect(resolveForecastPeriod('2027-Q1').months[0]!.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(resolveForecastPeriod(undefined, new Date('2026-12-31T23:00:00Z')).period).toBe('2026-12');
    expect(() => resolveForecastPeriod('2026-13')).toThrow();
  });
});

describe('forecasts R1 numbers', () => {
  it('每行指标：目标、赢单、完成率、差额、在手、加权、预测、最好情况；按币种与期间过滤 / per-row metrics', async () => {
    await setTarget({ userId: a.user.id, month: '2026-11', amount: '1000' });
    await f.deal('CLOSED_WON', '600', { ownerId: a.user.id, close: '2026-11-10' });
    await f.deal('CLOSED_WON', '999', { ownerId: a.user.id, close: '2026-10-31' });
    await f.deal('CLOSED_WON', '50', { ownerId: a.user.id, close: '2026-11-10', currency: 'USD' });
    await f.deal('PROPOSAL', '500', { ownerId: a.user.id, close: '2026-11-30' });
    await f.deal('NEGOTIATION', '100', { ownerId: a.user.id, close: '2026-11-01' });
    await f.deal('QUALIFICATION', '1000', { ownerId: a.user.id, close: '2026-12-01' });
    await f.deal('CLOSED_LOST', '700', { ownerId: a.user.id, close: '2026-11-05' });
    const r = await get({ period: '2026-11', currency: 'CNY' });
    expect(r.rows).toEqual([
      {
        ownerId: a.user.id,
        name: a.user.name,
        target: '1000.00',
        won: '600.00',
        wonCount: 1,
        gap: '400.00',
        attainment: 60,
        open: '600.00',
        openCount: 2,
        weighted: '270.00',
        forecast: '870.00',
        forecastAttainment: 87,
        bestCase: '1200.00',
      },
    ]);
    expect(r).toMatchObject({ kind: 'month', months: ['2026-11'], canEdit: true, probabilities: { QUALIFICATION: 10, NEEDS_ANALYSIS: 20, PROPOSAL: 40, NEGOTIATION: 70 } });
  });

  it('季度：目标为三月之和，季度不可编辑；合计行；超额时差额为负 / quarter view and totals', async () => {
    const b = await addUser(a.org.id, 'SALES', '乙');
    for (const month of ['2026-10', '2026-11', '2026-12']) await setTarget({ userId: a.user.id, month, amount: '100' });
    await setTarget({ userId: b.user.id, month: '2026-12', amount: '50' });
    await f.deal('CLOSED_WON', '400', { ownerId: a.user.id, close: '2026-10-01' });
    await f.deal('CLOSED_WON', '20', { ownerId: b.user.id, close: '2026-12-31' });
    const r = await get({ period: '2026-Q4' });
    const rowA = r.rows.find((x: { ownerId: string }) => x.ownerId === a.user.id);
    expect(rowA).toMatchObject({ target: '300.00', won: '400.00', gap: '-100.00', attainment: 133.3 });
    expect(r.canEdit).toBe(false);
    expect(r.totals).toMatchObject({ ownerId: null, target: '350.00', won: '420.00', wonCount: 2, attainment: 120 });
  });

  it('参与统计的用户：未停用的非只读用户（即使无数据）、有商机的已停用用户、未分配商机；无目标时合计目标为空 / who is listed', async () => {
    const viewer = await addUser(a.org.id, 'READONLY');
    const gone = await addUser(a.org.id, 'SALES', '离职');
    await prisma.user.update({ where: { id: gone.user.id }, data: { isActive: false } });
    await f.deal('PROPOSAL', '10', { ownerId: gone.user.id, close: '2026-11-02' });
    await f.deal('NEGOTIATION', '20', { close: '2026-11-03' });
    const r = await get({ period: '2026-11' });
    const ids = r.rows.map((x: { ownerId: string | null }) => x.ownerId);
    expect(ids).toContain(a.user.id);
    expect(ids).toContain(gone.user.id);
    expect(ids).not.toContain(viewer.user.id);
    expect(ids[ids.length - 1]).toBeNull();
    expect(r.rows.find((x: { ownerId: string | null }) => x.ownerId === a.user.id)).toMatchObject({ target: null, won: '0.00', attainment: null });
    expect(r.totals).toMatchObject({ target: null, open: '30.00', weighted: '18.00' });
  });
});

describe('forecasts R1 targets', () => {
  it('设定、修改、清除目标；按月 1 日存储；审计记录前后值，未变化不写审计 / set, change and clear', async () => {
    expect((await setTarget({ userId: a.user.id, month: '2026-11', amount: '1000' })).json).toEqual({ userId: a.user.id, month: '2026-11', currency: 'CNY', amount: '1000.00' });
    await setTarget({ userId: a.user.id, month: '2026-11', amount: '1200.5' });
    await setTarget({ userId: a.user.id, month: '2026-11', amount: '1200.50' });
    const row = await prisma.salesTarget.findFirstOrThrow();
    expect([row.month.toISOString().slice(0, 10), row.amount.toFixed(2), row.updatedById]).toEqual(['2026-11-01', '1200.50', a.user.id]);
    expect((await setTarget({ userId: a.user.id, month: '2026-11', amount: null })).json.amount).toBeNull();
    expect(await prisma.salesTarget.count()).toBe(0);
    const logs = await prisma.auditLog.findMany({ where: { action: 'target.update' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => (l.changes as { fields: { amount: unknown[] } }).fields.amount)).toEqual([
      [null, '1000.00'],
      ['1000.00', '1200.50'],
      ['1200.50', null],
    ]);
    expect(logs[0]!.changes).toMatchObject({ userId: a.user.id, month: '2026-11', currency: 'CNY' });
  });

  it('演示数据：本月经理人民币目标与销售美元目标 / demo targets', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const { token } = await addUser(org.id, 'READONLY', 'FCVIEW');
    const month = new Date().toISOString().slice(0, 7);
    const cny = await get({ period: month, currency: 'CNY' }, token);
    const manager = DEMO_USERS.find((u) => u.key === 'manager')!;
    const base = DEMO_TARGETS.find((x) => x.owner === 'manager')!.base;
    expect(cny.rows.find((x: { name: string }) => x.name === manager.name).target).toBe(demoTargetAmount(base, 0));
    const usd = await get({ period: month, currency: 'USD' }, token);
    expect(usd.rows.filter((x: { target: string | null }) => x.target !== null)).toHaveLength(2);
  });
});
