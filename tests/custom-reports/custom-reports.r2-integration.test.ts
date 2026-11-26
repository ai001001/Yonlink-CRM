/**
 * 自定义报表 第二轮：集成测试（演示报表：定义合法、各角色可见与运行结果与数据库直接统计一致；区域只读范围；组织隔离；
 * 并发新建的上限；超过 20000 条时截断；自定义下拉选项在分组与导出中；数据库约束；API 密钥）。
 * Custom reports round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as picklistItem from '@/app/api/picklists/[field]/route';
import * as picklists from '@/app/api/picklists/route';
import * as exportRoute from '@/app/api/custom-reports/[id]/export/route';
import * as reportItem from '@/app/api/custom-reports/[id]/route';
import * as runSaved from '@/app/api/custom-reports/[id]/run/route';
import * as reports from '@/app/api/custom-reports/route';
import * as preview from '@/app/api/custom-reports/run/route';
import * as territories from '@/app/api/territories/route';
import { hashToken } from '@/server/auth';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { definitionSchema, SUMMARY_MAX } from '@/server/modules/custom-reports';
import { DEMO_ORG_NAME, DEMO_REPORTS, DEMO_USERS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const run = (body: object, token = a.token) => call(preview.POST, { token, body });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('custom reports R2', () => {
  it('演示报表：定义合法、可见范围、结果与直接统计一致 / demo reports', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.customReport.findMany({ where: { organizationId: org.id } });
    expect(rows).toHaveLength(DEMO_REPORTS.length);
    for (const r of rows) {
      expect(r.name).toContain('【演示】');
      expect(definitionSchema.safeParse({ entity: r.entity, columns: r.columns, filters: r.filters, groupBy: r.groupBy, measures: r.measures, chart: r.chart, sort: r.sort }).success, r.name).toBe(true);
    }
    const users = await prisma.user.findMany({ where: { organizationId: org.id } });
    const { randomBytes } = await import('node:crypto');
    const tokenOf = async (key: (typeof DEMO_USERS)[number]['key']) => {
      const u = users.find((x) => x.email === DEMO_USERS.find((d) => d.key === key)!.email)!;
      const token = randomBytes(32).toString('base64url');
      await prisma.session.create({ data: { userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
      return { token, id: u.id };
    };
    const viewer = await tokenOf('viewer');
    const sales1 = await tokenOf('sales1');
    const names = async (token: string) => ((await call(reports.GET, { token })).json.items as { name: string }[]).map((x) => x.name).sort();
    const shared = DEMO_REPORTS.filter((r) => r.shared).map((r) => r.name);
    expect(await names(viewer.token)).toEqual([...shared].sort());
    expect(await names(sales1.token)).toEqual(DEMO_REPORTS.map((r) => r.name).sort());
    // 共享的美元阶段报表：只读用户看全部，与数据库直接统计一致 / the shared USD stage report matches a direct count
    const usd = rows.find((r) => r.name === DEMO_REPORTS[0]!.name)!;
    const res = (await call(runSaved.GET, { token: viewer.token, params: { id: usd.id } })).json;
    const direct = await prisma.deal.groupBy({ by: ['stage'], where: { organizationId: org.id, currency: 'USD' }, _count: { _all: true }, _sum: { amount: true } });
    for (const g of direct) {
      const got = res.groups.find((x: { key: string }) => x.key === g.stage);
      expect(got.count).toBe(g._count._all);
      expect(got.measures[0]).toBe(g._sum.amount!.toFixed(2));
    }
    expect(res.totals.count).toBe(direct.reduce((n, g) => n + g._count._all, 0));
    // 王芳运行同一共享报表，按她的可见范围（含所在区域）统计，与她的商机列表一致
    // 王芳 runs the same shared report within her scope (territories included), matching her deal list
    const mine = (await call(runSaved.GET, { token: sales1.token, params: { id: usd.id } })).json;
    const list = (await call(deals.GET, { token: sales1.token, query: { pageSize: '100' } })).json;
    expect(mine.totals.count).toBe(list.items.filter((x: { currency: string }) => x.currency === 'USD').length);
    // 郑经理负责的人民币商机不在她的范围内 / the manager's CNY deals stay outside her scope
    const cny = (await call(preview.POST, { token: sales1.token, body: { entity: 'DEAL', groupBy: { field: 'currency' } } })).json;
    expect(cny.groups.some((g: { key: string }) => g.key === 'CNY')).toBe(false);
    // 王芳的私有明细报表：按金额从高到低 / 王芳's private detail report, amount descending
    const detail = rows.find((r) => r.name === DEMO_REPORTS[2]!.name)!;
    const d = (await call(runSaved.GET, { token: sales1.token, params: { id: detail.id } })).json;
    const amounts = d.rows.map((x: { values: { amount: string } }) => Number(x.values.amount));
    expect(amounts).toEqual([...amounts].sort((p, q) => q - p));
    expect((await call(runSaved.GET, { token: viewer.token, params: { id: detail.id } })).status).toBe(404);
  });

  it('区域只读范围与组织隔离 / territory scope and isolation', async () => {
    const rep = await addUser(a.org.id, 'SALES', '区域代表');
    const owner = await addUser(a.org.id, 'SALES', '负责人');
    const ter = (await call(territories.POST, { token: a.token, body: { name: '华东', memberIds: [rep.user.id] } })).json;
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '区域客户', ownerId: owner.user.id, territoryId: ter.id } })).json;
    await call(deals.POST, { token: a.token, body: { name: '区域商机', accountId: acct.id, ownerId: owner.user.id, amount: '100' } });
    const def = { entity: 'DEAL', columns: ['name', 'accountId'] };
    expect((await run(def, rep.token)).json.rows.map((x: { values: { name: string } }) => x.values.name)).toEqual(['区域商机']);
    expect((await run({ entity: 'ACCOUNT', groupBy: { field: 'territoryId' } }, rep.token)).json.groups).toEqual([{ key: ter.id, name: '华东', count: 1, measures: [] }]);
    const b = await createTenant('B');
    const saved = (await call(reports.POST, { token: a.token, body: { name: '共享', ...def, shared: true } })).json;
    expect((await call(reportItem.GET, { token: b.token, params: { id: saved.id } })).status).toBe(404);
    expect((await call(runSaved.GET, { token: b.token, params: { id: saved.id } })).status).toBe(404);
    // B 用 A 的客户 ID 筛选得不到数据 / B filtering by A's account id gets nothing
    expect((await run({ entity: 'DEAL', columns: ['name'], filters: [{ field: 'accountId', op: 'EQUALS', value: acct.id }] }, b.token)).json.total).toBe(0);
    expect((await call(reports.GET, { token: b.token })).json.items).toEqual([]);
  });

  it('并发新建不超过上限；数据库约束 / concurrent cap and constraints', async () => {
    const res = await Promise.all(Array.from({ length: 55 }, (_, i) => call(reports.POST, { token: a.token, body: { name: `报表${i}`, entity: 'LEAD', columns: ['name'] } })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(50);
    expect(res.filter((r) => r.status === 409).every((r) => r.json.error.details.name[0] === 'limit_reached')).toBe(true);
    const base = { organizationId: a.org.id, ownerId: a.user.id, entity: 'LEAD' as const };
    const bad = [
      () => prisma.customReport.create({ data: { ...base, name: ' ' } }),
      () => prisma.customReport.create({ data: { ...base, name: '图表无分组', chart: 'BAR' } }),
      () => prisma.customReport.create({ data: { ...base, name: '图表类型', chart: 'PIE' } }),
      () => prisma.customReport.create({ data: { ...base, name: '列不是数组', columns: { a: 1 } } }),
      () => prisma.customReport.create({ data: { ...base, name: '报表0' } }),
    ];
    for (const [i, f] of bad.entries()) await expect(f(), `case ${i}`).rejects.toThrow();
    const b = await createTenant('B');
    await expect(prisma.customReport.create({ data: { organizationId: b.org.id, ownerId: a.user.id, entity: 'LEAD', name: '跨组织' } })).rejects.toThrow();
  });

  it('超过汇总上限时截断 / summaries truncate beyond the cap', async () => {
    const n = SUMMARY_MAX + 5;
    await prisma.lead.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: a.org.id, ownerId: a.user.id, name: `批量${i}`, source: i % 2 ? 'WEBSITE' : 'REFERRAL' })) });
    const r = (await run({ entity: 'LEAD', groupBy: { field: 'source' } })).json;
    expect(r.truncated).toBe(true);
    expect(r.totals.count).toBe(SUMMARY_MAX);
    // 明细只按页读取，总数准确 / details page and count exactly
    expect((await run({ entity: 'LEAD', columns: ['name'] })).json.total).toBe(n);
  });

  it('自定义下拉选项与 API 密钥 / custom options and API keys', async () => {
    const values = (await call(picklists.GET, { token: a.token })).json.fields.LEAD_SOURCE.map((o: { value: string }) => ({ value: o.value, isActive: true, label: o.value === 'WEBSITE' ? '公司官网' : null }));
    const live = (await call(picklistItem.PUT, { token: a.token, params: { field: 'LEAD_SOURCE' }, body: { values: [...values, { label: '直播间', isActive: true }] }, method: 'PUT' })).json.items.find((o: { label: string }) => o.label === '直播间').value;
    await call(leads.POST, { token: a.token, body: { name: '直播线索', source: live } });
    await call(leads.POST, { token: a.token, body: { name: '官网线索', source: 'WEBSITE' } });
    expect((await run({ entity: 'LEAD', columns: ['name'], filters: [{ field: 'source', op: 'EQUALS', value: live }] })).json.total).toBe(1);
    const saved = (await call(reports.POST, { token: a.token, body: { name: '来源', entity: 'LEAD', groupBy: { field: 'source' } } })).json;
    const res = await exportRoute.GET(new Request('http://localhost/x', { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({ id: saved.id }) });
    const csv = parseCsv(await res.text());
    expect(csv.map((r) => r[0])).toEqual(expect.arrayContaining(['直播间', '公司官网', '合计']));
    // API 密钥按其用户 / API keys act as their user
    const sales = await addUser(a.org.id, 'SALES', '销售');
    const keys = await import('@/app/api/api-keys/route');
    const key = (await call(keys.POST, { token: a.token, body: { name: '销售密钥', userId: sales.user.id } })).json.key;
    expect((await call(runSaved.GET, { token: key, params: { id: saved.id } })).status).toBe(404);
    const own = await call(reports.POST, { token: key, body: { name: '密钥报表', entity: 'LEAD', columns: ['name'] } });
    expect(own.json.owner.id).toBe(sales.user.id);
    expect((await call(runSaved.GET, { token: key, params: { id: own.json.id } })).json.total).toBe(0);
  });
});
