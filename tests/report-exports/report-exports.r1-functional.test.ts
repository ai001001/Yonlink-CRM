/**
 * 报表导出 第一轮：功能测试（销售报表各板块与接口一致、中英文、文件名与响应头；销售预测各行与合计一致；公式注入防护；审计）。
 * Report exports round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as deals from '@/app/api/deals/route';
import * as forecastExport from '@/app/api/forecasts/export/route';
import * as forecasts from '@/app/api/forecasts/route';
import * as targets from '@/app/api/forecasts/targets/route';
import * as leads from '@/app/api/leads/route';
import * as salesExport from '@/app/api/reports/sales/export/route';
import * as sales from '@/app/api/reports/sales/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const month = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);

/** 调用导出接口并解析 / call an export route and parse the CSV */
async function download(route: { GET: (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response> }, path: string, query: Record<string, string>, token = a.token) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await route.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  const text = (await res.text()).replace(/^﻿/, '');
  // 项目的 parseCsv 为导入而写，会去掉空行；分段按原始文本中的空行切分
  // the project's parseCsv (written for imports) drops blank lines, so sections are split on the raw text
  const blocks = res.status === 200 ? text.split('\r\n\r\n').map((b) => parseCsv(b)) : [];
  return { res, rows: res.status === 200 ? parseCsv(text) : [], blocks };
}

/** 取出某段（标题行之后的各行，含表头）/ rows of a section after its title (header included) */
function section(blocks: string[][][], title: string): string[][] {
  const block = blocks.find((b) => b[0]?.length === 1 && b[0][0] === title);
  expect(block, title).toBeDefined();
  return block!.slice(1);
}

/** 造数：客户、各阶段商机、线索 / seed: an account, deals in several stages, leads */
async function seed(ownerId?: string) {
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '报表客户' } })).json;
  const deal = async (name: string, amount: string, stage: string) => {
    const r = await call(deals.POST, { token: a.token, body: { name, accountId: acc.id, amount, stage, expectedCloseDate: today, ...(ownerId ? { ownerId } : {}) } });
    expect(r.status).toBe(201);
  };
  await deal('赢单一', '1000.50', 'CLOSED_WON');
  await deal('输单一', '300', 'CLOSED_LOST');
  await deal('谈判中', '2000', 'NEGOTIATION');
  await deal('需求分析', '500', 'NEEDS_ANALYSIS');
  for (const source of ['WEBSITE', 'WEBSITE', 'REFERRAL']) expect((await call(leads.POST, { token: a.token, body: { name: `线索${source}`, source } })).status).toBe(201);
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('report exports R1 sales', () => {
  it('各板块与接口一致，含筛选说明、文件名与响应头 / every section matches the API', async () => {
    await seed();
    const q = { currency: 'CNY', from: `${month}-01`, to: today };
    const json = (await call(sales.GET, { token: a.token, query: q })).json;
    const { res, rows, blocks } = await download(salesExport, '/api/reports/sales/export', q);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="sales-report-CNY-${q.from.replace(/-/g, '')}-${today.replace(/-/g, '')}.csv"`);
    expect(rows[0]).toEqual(['销售报表']);
    expect(rows.slice(1, 4)).toEqual([['币种', 'CNY'], ['时间段', `${q.from} ~ ${today}`], ['负责人', '全部负责人']]);
    const summary = Object.fromEntries(section(blocks, '概览').slice(1).map((r) => [r[0], r[1]]));
    expect(summary).toMatchObject({
      进行中商机金额: json.summary.openAmount,
      进行中: String(json.summary.openCount),
      期间赢单金额: '1000.50',
      期间输单金额: '300.00',
      '赢单率 %': '50',
      线索数: '3',
      '线索转化率 %': '0',
      '报价接受率 %': '',
    });
    expect(section(blocks, '销售漏斗（进行中商机）')).toEqual([
      ['阶段', '数量', '金额'],
      ...json.funnel.map((f: { count: number; amount: string }, i: number) => [['资格确认', '需求分析', '方案报价', '商务谈判'][i], String(f.count), f.amount]),
    ]);
    const monthly = section(blocks, '按月赢单');
    expect(monthly[0]).toEqual(['月份', '赢单数', '赢单金额', '输单数']);
    expect(monthly.slice(1).find((r) => r[0] === month)).toEqual([month, '1', '1000.50', '1']);
    expect(monthly).toHaveLength(json.monthly.length + 1);
    expect(section(blocks, '负责人排行')[1]).toEqual([a.user.name, '2', '2500.00', '1', '1000.50', '1', '50', '0']);
    expect(section(blocks, '线索来源转化').slice(1)).toEqual([['官网', '2', '0', '0'], ['客户推荐', '1', '0', '0']]);
    expect(section(blocks, '报价单状态').slice(1).map((r) => r[0])).toEqual(['草稿', '已发送', '已接受', '已拒绝']);
  });

  it('英文表头、负责人筛选显示姓名、公式注入防护 / English, owner name, formula guard', async () => {
    const evil = await addUser(a.org.id, 'SALES', '=SUM(A1)');
    await seed(evil.user.id);
    const { rows, blocks } = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', ownerId: evil.user.id, lang: 'en-US' });
    expect(rows[0]).toEqual(['Sales reports']);
    expect(rows[3]![0]).toBe('Owner');
    expect(rows[3]![1]).toBe(`'${evil.user.name}`);
    expect(section(blocks, 'Summary')[0]).toEqual(['Metric', 'Value']);
    expect(section(blocks, (await import('@/i18n')).translate('en-US', 'reports.owners'))[1]![0]).toBe(`'${evil.user.name}`);
  });
});

describe('report exports R1 forecast', () => {
  it('每位负责人一行加团队合计，与接口一致 / rows and totals match the API', async () => {
    await seed();
    expect((await call(targets.PUT, { token: a.token, body: { userId: a.user.id, month, currency: 'CNY', amount: '5000' }, method: 'PUT' })).status).toBe(200);
    const json = (await call(forecasts.GET, { token: a.token, query: { period: month, currency: 'CNY' } })).json;
    const { res, rows } = await download(forecastExport, '/api/forecasts/export', { period: month, currency: 'CNY' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="forecast-CNY-${month}.csv"`);
    expect(rows[0]).toEqual(['负责人', '目标', '已赢单', '赢单数', '完成率 %', '距离目标', '在手商机', '在手商机数', '加权预测', '预测', '预测完成率 %', '最好情况']);
    const mine = json.rows.find((r: { ownerId: string }) => r.ownerId === a.user.id);
    expect(rows.find((r) => r[0] === a.user.name)).toEqual([
      a.user.name, '5000.00', mine.won, String(mine.wonCount), String(mine.attainment), mine.gap, mine.open, String(mine.openCount), mine.weighted, mine.forecast, String(mine.forecastAttainment), mine.bestCase,
    ]);
    expect(rows.at(-1)![0]).toBe('团队合计');
    expect(rows.at(-1)![9]).toBe(json.totals.forecast);
    expect(rows).toHaveLength(json.rows.length + 2);
  });

  it('季度期间；无目标时目标与完成率留空 / quarter period, empty target cells', async () => {
    await seed();
    const quarter = `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5)) - 1) / 3) + 1}`;
    const { res, rows } = await download(forecastExport, '/api/forecasts/export', { period: quarter, lang: 'en-US' });
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="forecast-CNY-${quarter}.csv"`);
    expect(rows[0]![0]).toBe('Owner');
    const row = rows.find((r) => r[0] === a.user.name)!;
    expect([row[1], row[4], row[5], row[10]]).toEqual(['', '', '', '']);
    expect(rows.at(-1)![0]).toBe('Team total');
  });
});

describe('report exports R1 audit', () => {
  it('导出写审计：报表名、筛选与行数 / exports are audited', async () => {
    await download(salesExport, '/api/reports/sales/export', { currency: 'USD', from: '2026-01-01', to: '2026-03-31' });
    await download(forecastExport, '/api/forecasts/export', { period: '2026-02', currency: 'EUR' });
    const logs = await prisma.auditLog.findMany({ where: { action: 'report.export' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => [l.entityType, l.entityId, l.actorId])).toEqual([
      ['report', null, a.user.id],
      ['report', null, a.user.id],
    ]);
    expect(logs[0]!.changes).toMatchObject({ report: 'sales', filters: { currency: 'USD', from: '2026-01-01', to: '2026-03-31' } });
    expect(logs[1]!.changes).toMatchObject({ report: 'forecast', filters: { period: '2026-02', currency: 'EUR' } });
  });
});
