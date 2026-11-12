/**
 * 销售报表 第一轮：功能测试（漏斗、按月、汇总、负责人排行、线索来源、报价单、时间段边界、比率）。
 * Sales reports round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as reports from '@/app/api/reports/sales/route';
import { rate, resolvePeriod } from '@/server/modules/reports';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { fixtures } from './fixtures';

let a: Awaited<ReturnType<typeof createTenant>>;
let f: Awaited<ReturnType<typeof fixtures>>;
const PERIOD = { from: '2026-01-01', to: '2026-06-30' };
const report = async (query: Record<string, string> = {}) => {
  const res = await call(reports.GET, { token: a.token, query: { ...PERIOD, ...query } });
  expect(res.status).toBe(200);
  return res.json;
};

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  f = await fixtures(a.org.id);
});

describe('reports R1 deals', () => {
  beforeEach(async () => {
    await f.deal('QUALIFICATION', '100');
    await f.deal('PROPOSAL', '200.50');
    await f.deal('PROPOSAL', '300');
    await f.deal('NEGOTIATION', '50', { close: '2030-01-01' });
    await f.deal('PROPOSAL', '999', { currency: 'USD' });
    await f.deal('CLOSED_WON', '1000', { close: '2026-02-10' });
    await f.deal('CLOSED_WON', '500', { close: '2026-02-20' });
    await f.deal('CLOSED_WON', '700', { close: '2026-06-30' });
    await f.deal('CLOSED_LOST', '400', { close: '2026-03-05' });
    await f.deal('CLOSED_WON', '9999', { close: '2025-12-31' });
    await f.deal('CLOSED_WON', '8888', { close: '2026-07-01' });
    await f.deal('CLOSED_WON', '7777');
  });

  it('漏斗：进行中商机按阶段（补零、只算所选币种、不受时间段影响）/ funnel', async () => {
    const r = await report();
    expect(r.funnel).toEqual([
      { stage: 'QUALIFICATION', count: 1, amount: '100.00' },
      { stage: 'NEEDS_ANALYSIS', count: 0, amount: '0.00' },
      { stage: 'PROPOSAL', count: 2, amount: '500.50' },
      { stage: 'NEGOTIATION', count: 1, amount: '50.00' },
    ]);
    expect(r.summary).toMatchObject({ openCount: 4, openAmount: '650.50' });
    expect((await report({ from: '2020-01-01', to: '2020-01-31' })).funnel).toEqual(r.funnel);
  });

  it('期间赢单/输单与赢单率（按预计成交日期，含边界日，排除无日期）/ won and lost in the period', async () => {
    const r = await report();
    expect(r.summary).toMatchObject({ wonCount: 3, wonAmount: '2200.00', lostCount: 1, lostAmount: '400.00', winRate: 75 });
  });

  it('按月：时间段内每月一行（补零），赢单金额与输单数 / monthly rows', async () => {
    const r = await report();
    expect(r.monthly.map((m: { month: string }) => m.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(r.monthly[1]).toEqual({ month: '2026-02', wonCount: 2, wonAmount: '1500.00', lostCount: 0 });
    expect(r.monthly[2]).toEqual({ month: '2026-03', wonCount: 0, wonAmount: '0.00', lostCount: 1 });
    expect(r.monthly[5]).toEqual({ month: '2026-06', wonCount: 1, wonAmount: '700.00', lostCount: 0 });
    expect(r.monthly[0]).toEqual({ month: '2026-01', wonCount: 0, wonAmount: '0.00', lostCount: 0 });
  });

  it('币种：USD 单独统计；返回可选币种列表 / currencies are separate', async () => {
    const r = await report({ currency: 'USD' });
    expect(r.summary).toMatchObject({ openCount: 1, openAmount: '999.00', wonCount: 0, winRate: null });
    expect(r.currencies).toEqual(['CNY', 'USD']);
    expect((await report({ currency: 'EUR' })).summary.openAmount).toBe('0.00');
  });
});

describe('reports R1 owners, leads, quotes', () => {
  it('负责人排行：按赢单金额排序，含在手、输单、赢单率与期间跟进数；未分配单列 / owner ranking', async () => {
    const u1 = await addUser(a.org.id, 'SALES', '甲');
    const u2 = await addUser(a.org.id, 'SALES', '乙');
    await f.deal('PROPOSAL', '300', { ownerId: u1.user.id });
    await f.deal('CLOSED_WON', '100', { ownerId: u1.user.id, close: '2026-02-01' });
    await f.deal('CLOSED_LOST', '50', { ownerId: u1.user.id, close: '2026-02-02' });
    await f.deal('CLOSED_WON', '900', { ownerId: u2.user.id, close: '2026-03-01' });
    await f.deal('NEGOTIATION', '10');
    await f.activity(u1.user.id, '2026-02-01T08:00:00Z');
    await f.activity(u1.user.id, '2026-06-30T23:59:59Z');
    await f.activity(u1.user.id, '2026-07-01T00:00:00Z');
    const r = await report();
    expect(r.owners).toEqual([
      { ownerId: u2.user.id, name: u2.user.name, openCount: 0, openAmount: '0.00', wonCount: 1, wonAmount: '900.00', lostCount: 0, winRate: 100, activities: 0 },
      { ownerId: u1.user.id, name: u1.user.name, openCount: 1, openAmount: '300.00', wonCount: 1, wonAmount: '100.00', lostCount: 1, winRate: 50, activities: 2 },
      { ownerId: null, name: null, openCount: 1, openAmount: '10.00', wonCount: 0, wonAmount: '0.00', lostCount: 0, winRate: null, activities: 0 },
    ]);
  });

  it('负责人筛选：只统计该负责人 / owner filter', async () => {
    const u1 = await addUser(a.org.id, 'SALES', '甲');
    await f.deal('PROPOSAL', '300', { ownerId: u1.user.id });
    await f.deal('PROPOSAL', '7');
    await f.lead('WEBSITE', 'NEW', '2026-02-01T00:00:00Z', u1.user.id);
    await f.lead('WEBSITE', 'NEW', '2026-02-01T00:00:00Z');
    const r = await report({ ownerId: u1.user.id });
    expect(r.summary).toMatchObject({ openCount: 1, openAmount: '300.00', leadTotal: 1 });
    expect(r.owners.map((o: { ownerId: string }) => o.ownerId)).toEqual([u1.user.id]);
  });

  it('线索来源：期间内创建（UTC 边界），转化数与转化率，按数量排序 / lead sources', async () => {
    await f.lead('EXHIBITION', 'CONVERTED', '2026-01-01T00:00:00Z');
    await f.lead('EXHIBITION', 'NEW', '2026-03-01T00:00:00Z');
    await f.lead('EXHIBITION', 'CONTACTED', '2026-06-30T23:59:59Z');
    await f.lead('WEBSITE', 'CONVERTED', '2026-04-01T00:00:00Z');
    await f.lead(null, 'NEW', '2026-04-01T00:00:00Z');
    await f.lead('WEBSITE', 'CONVERTED', '2025-12-31T23:59:59Z');
    await f.lead('WEBSITE', 'CONVERTED', '2026-07-01T00:00:00Z');
    const r = await report();
    expect(r.summary).toMatchObject({ leadTotal: 5, leadConverted: 2, leadConversionRate: 40 });
    expect(r.leadSources[0]).toEqual({ source: 'EXHIBITION', total: 3, converted: 1, conversionRate: 33.3 });
    expect(r.leadSources).toContainEqual({ source: 'WEBSITE', total: 1, converted: 1, conversionRate: 100 });
    expect(r.leadSources).toContainEqual({ source: null, total: 1, converted: 0, conversionRate: 0 });
  });

  it('报价单：期间内、所选币种的状态数量与金额，接受率 / quotes', async () => {
    const d = await f.deal('PROPOSAL', '1');
    const du = await f.deal('PROPOSAL', '1', { currency: 'USD' });
    await f.quote(d.id, 'ACCEPTED', '100.10', '2026-02-01T00:00:00Z');
    await f.quote(d.id, 'ACCEPTED', '200', '2026-03-01T00:00:00Z');
    await f.quote(d.id, 'REJECTED', '50', '2026-03-02T00:00:00Z');
    await f.quote(d.id, 'SENT', '30', '2026-04-01T00:00:00Z');
    await f.quote(d.id, 'ACCEPTED', '9999', '2026-07-01T00:00:00Z');
    await f.quote(du.id, 'ACCEPTED', '1', '2026-02-01T00:00:00Z', 'USD');
    const r = await report();
    expect(r.quotes).toEqual([
      { status: 'DRAFT', count: 0, amount: '0.00' },
      { status: 'SENT', count: 1, amount: '30.00' },
      { status: 'ACCEPTED', count: 2, amount: '300.10' },
      { status: 'REJECTED', count: 1, amount: '50.00' },
    ]);
    expect(r.summary.quoteAcceptanceRate).toBe(66.7);
  });
});

describe('reports R1 period & helpers', () => {
  it('默认时间段：最近 12 个月（含本月），结束为今天 / default period', () => {
    const p = resolvePeriod(undefined, undefined, new Date('2026-11-12T10:00:00Z'));
    expect([p.from, p.to]).toEqual(['2025-12-01', '2026-11-12']);
    expect(p.months).toHaveLength(12);
    expect(p.months[0]).toBe('2025-12');
    expect(p.months[11]).toBe('2026-11');
    expect(p.endExclusive.toISOString()).toBe('2026-11-13T00:00:00.000Z');
  });

  it('跨年与 24 个月上限 / year boundaries and the 24-month limit', () => {
    expect(resolvePeriod('2025-11-15', '2026-02-01').months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(resolvePeriod('2024-01-01', '2025-12-31').months).toHaveLength(24);
    expect(() => resolvePeriod('2024-01-01', '2026-01-01')).toThrow();
    expect(() => resolvePeriod('2026-02-01', '2026-01-31')).toThrow();
    expect(resolvePeriod('2026-02-01', '2026-02-01').months).toEqual(['2026-02']);
  });

  it('比率：1 位小数，分母为 0 时为 null / rates', () => {
    expect([rate(2, 3), rate(1, 3), rate(0, 5), rate(5, 5), rate(0, 0)]).toEqual([66.7, 33.3, 0, 100, null]);
  });

  it('空组织：全部为零，比率为 null / empty organization', async () => {
    const r = await report();
    expect(r.summary).toEqual({
      openCount: 0, openAmount: '0.00', wonCount: 0, wonAmount: '0.00', lostCount: 0, lostAmount: '0.00',
      winRate: null, leadTotal: 0, leadConverted: 0, leadConversionRate: null, quoteAcceptanceRate: null,
    });
    expect(r.owners).toEqual([]);
    expect(r.monthly).toHaveLength(6);
  });
});
