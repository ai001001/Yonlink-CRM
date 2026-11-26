/**
 * 自定义报表 第一轮：功能测试（定义校验；明细报表：列、筛选各运算、排序、分页、关联名称；汇总：按枚举、负责人、日期月份
 * 分组，计数与合计/平均/最小/最大，金额须单一币种；按查看者可见范围；维护：私有、共享、只有创建者能改、删除权限、
 * 名称唯一、审计；导出 CSV 与 Excel）。
 * Custom reports round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as exportRoute from '@/app/api/custom-reports/[id]/export/route';
import * as reportItem from '@/app/api/custom-reports/[id]/route';
import * as runSaved from '@/app/api/custom-reports/[id]/run/route';
import * as fieldsRoute from '@/app/api/custom-reports/fields/route';
import * as reports from '@/app/api/custom-reports/route';
import * as preview from '@/app/api/custom-reports/run/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;

const run = (body: object, token = a.token, query: Record<string, string> = {}) => call(preview.POST, { token, body, query });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

/** 准备数据：两个客户、四个商机（两种币种）、三条线索 / seed two accounts, four deals (two currencies), three leads */
async function seed() {
  const acc1 = (await call(accounts.POST, { token: a.token, body: { name: '甲客户', industry: 'IT', ownerId: sales.user.id } })).json;
  const acc2 = (await call(accounts.POST, { token: a.token, body: { name: '乙客户', industry: 'RETAIL' } })).json;
  const d = async (name: string, accountId: string, amount: string, currency: string, stage: string, ownerId: string) =>
    (await call(deals.POST, { token: a.token, body: { name, accountId, amount, currency, stage, ownerId } })).json;
  await d('商机一', acc1.id, '1000', 'CNY', 'PROPOSAL', sales.user.id);
  await d('商机二', acc1.id, '3000', 'CNY', 'PROPOSAL', sales.user.id);
  await d('商机三', acc2.id, '500', 'USD', 'CLOSED_WON', a.user.id);
  await d('商机四', acc2.id, '2000', 'CNY', 'NEGOTIATION', a.user.id);
  for (const [name, source, company] of [['线索甲', 'WEBSITE', '甲公司'], ['线索乙', 'WEBSITE', null], ['线索丙', 'REFERRAL', '丙公司']] as const) {
    await call(leads.POST, { token: a.token, body: { name, source, company } });
  }
  return { acc1, acc2 };
}

describe('custom reports R1 run', () => {
  it('字段目录与定义校验 / catalogue and validation', async () => {
    const cat = (await call(fieldsRoute.GET, { token: sales.token })).json;
    expect(Object.keys(cat.fields)).toEqual(['LEAD', 'ACCOUNT', 'DEAL', 'ACTIVITY']);
    expect(cat.fields.DEAL.amount.type).toBe('amount');
    const bad: object[] = [
      { entity: 'LEAD', columns: [] },
      { entity: 'LEAD', columns: ['nope'] },
      { entity: 'LEAD', columns: ['name', 'name'] },
      { entity: 'LEAD', columns: ['name'], filters: [{ field: 'name', op: 'GTE', value: 'x' }] },
      { entity: 'LEAD', columns: ['name'], filters: [{ field: 'source', op: 'EQUALS', value: 'bad value' }] },
      { entity: 'LEAD', columns: ['name'], filters: [{ field: 'createdAt', op: 'GTE', value: '2026-02-30' }] },
      { entity: 'LEAD', columns: ['name'], filters: [{ field: 'createdAt', op: 'THIS_MONTH', value: 'x' }] },
      { entity: 'LEAD', columns: ['name'], filters: [{ field: 'ownerId', op: 'EQUALS', value: 'someone' }] },
      { entity: 'LEAD', groupBy: { field: 'name' } },
      { entity: 'LEAD', groupBy: { field: 'createdAt' } },
      { entity: 'LEAD', groupBy: { field: 'status', unit: 'month' } },
      { entity: 'LEAD', columns: ['name'], measures: [{ fn: 'SUM', field: 'score' }] },
      { entity: 'LEAD', columns: ['name'], chart: 'BAR' },
      { entity: 'DEAL', groupBy: { field: 'stage' }, measures: [{ fn: 'SUM', field: 'amount' }] },
      { entity: 'DEAL', groupBy: { field: 'stage' }, measures: [{ fn: 'SUM', field: 'name' }] },
      { entity: 'DEAL', columns: ['name'], sort: { field: 'accountId', dir: 'asc' } },
      { entity: 'CONTACT', columns: ['name'] },
    ];
    for (const body of bad) expect((await run(body)).status, JSON.stringify(body)).toBe(400);
  });

  it('明细：列、筛选、排序、分页、关联名称 / details', async () => {
    const { acc1 } = await seed();
    const r = (await run({ entity: 'DEAL', columns: ['name', 'accountId', 'amount', 'stage', 'ownerId'], filters: [{ field: 'currency', op: 'EQUALS', value: 'CNY' }], sort: { field: 'amount', dir: 'desc' } })).json;
    expect(r.kind).toBe('detail');
    expect(r.total).toBe(3);
    expect(r.rows.map((x: { values: { name: string } }) => x.values.name)).toEqual(['商机二', '商机四', '商机一']);
    expect(r.rows[0].values).toMatchObject({ amount: '3000.00', currency: 'CNY', stage: 'PROPOSAL', accountId: { id: acc1.id, name: '甲客户' }, ownerId: { name: sales.user.name } });
    const paged = (await run({ entity: 'DEAL', columns: ['name'], sort: { field: 'name', dir: 'asc' } }, a.token, { page: '2', pageSize: '3' })).json;
    expect([paged.total, paged.rows.length, paged.page]).toEqual([4, 1, 2]);
    const cases: [object, string[]][] = [
      [{ field: 'name', op: 'CONTAINS', value: '甲' }, ['线索甲']],
      [{ field: 'company', op: 'EMPTY' }, ['线索乙']],
      [{ field: 'company', op: 'NOT_EMPTY' }, ['线索甲', '线索丙']],
      [{ field: 'source', op: 'NOT_EQUALS', value: 'WEBSITE' }, ['线索丙']],
      [{ field: 'createdAt', op: 'LAST_DAYS', value: '1' }, ['线索甲', '线索乙', '线索丙']],
      [{ field: 'createdAt', op: 'LTE', value: '2000-01-01' }, []],
      [{ field: 'ownerId', op: 'EQUALS', value: 'ME' }, ['线索甲', '线索乙', '线索丙']],
      [{ field: 'name', op: 'EQUALS', value: '线索乙' }, ['线索乙']],
    ];
    for (const [f, names] of cases) {
      const res = (await run({ entity: 'LEAD', columns: ['name'], filters: [f], sort: { field: 'name', dir: 'desc' } })).json;
      expect(res.rows.map((x: { values: { name: string } }) => x.values.name), JSON.stringify(f)).toEqual(names);
    }
    // 布尔与关联客户 / boolean and related account
    await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '电话甲', accountId: acc1.id } });
    await call(activities.POST, { token: a.token, body: { type: 'TASK', subject: '任务乙', completed: true } });
    expect((await run({ entity: 'ACTIVITY', columns: ['subject'], filters: [{ field: 'completed', op: 'TRUE' }] })).json.rows.map((x: { values: { subject: string } }) => x.values.subject)).toEqual(['任务乙']);
    expect((await run({ entity: 'ACTIVITY', columns: ['subject', 'accountId'], filters: [{ field: 'accountId', op: 'EQUALS', value: acc1.id }] })).json.rows[0].values).toMatchObject({ subject: '电话甲', accountId: { name: '甲客户' } });
  });

  it('汇总：按阶段、负责人、币种、月份分组；指标；可见范围 / summaries and visibility', async () => {
    await seed();
    const byStage = (await run({ entity: 'DEAL', groupBy: { field: 'stage' }, filters: [{ field: 'currency', op: 'EQUALS', value: 'CNY' }], measures: [{ fn: 'SUM', field: 'amount' }, { fn: 'AVG', field: 'amount' }, { fn: 'MAX', field: 'amount' }], chart: 'BAR' })).json;
    expect(byStage.kind).toBe('summary');
    expect(byStage.currency).toBe('CNY');
    expect(byStage.groups).toEqual([
      { key: 'PROPOSAL', count: 2, measures: ['4000.00', '2000.00', '3000.00'] },
      { key: 'NEGOTIATION', count: 1, measures: ['2000.00', '2000.00', '2000.00'] },
    ]);
    expect(byStage.totals).toEqual({ count: 3, measures: ['6000.00', '2000.00', '3000.00'] });
    const byCurrency = (await run({ entity: 'DEAL', groupBy: { field: 'currency' }, measures: [{ fn: 'SUM', field: 'amount' }] })).json;
    expect(byCurrency.groups).toEqual([
      { key: 'CNY', count: 3, measures: ['6000.00'] },
      { key: 'USD', count: 1, measures: ['500.00'] },
    ]);
    const byOwner = (await run({ entity: 'DEAL', groupBy: { field: 'ownerId' } })).json;
    // 数量相同时顺序不定，按名称比较 / ties have no fixed order, so compare sorted by name
    expect(byOwner.groups.map((g: { name: string; count: number }) => [g.name, g.count]).sort()).toEqual([[a.user.name, 2], [sales.user.name, 2]].sort());
    const month = new Date().toISOString().slice(0, 7);
    const byMonth = (await run({ entity: 'LEAD', groupBy: { field: 'createdAt', unit: 'month' }, measures: [{ fn: 'MIN', field: 'score' }] })).json;
    expect(byMonth.groups).toEqual([{ key: month, count: 3, measures: [0] }]);
    const byQuarter = (await run({ entity: 'LEAD', groupBy: { field: 'createdAt', unit: 'quarter' } })).json;
    expect(byQuarter.groups[0].key).toMatch(/^\d{4}-Q[1-4]$/);
    // 空值分组排最后 / the empty group comes last
    const byCompany = (await run({ entity: 'ACCOUNT', groupBy: { field: 'territoryId' } })).json;
    expect(byCompany.groups).toEqual([{ key: null, count: 2, measures: [], name: null }]);
    // 可见范围：销售只看到自己负责的 / visibility: sales see their own records
    const salesView = (await run({ entity: 'DEAL', groupBy: { field: 'stage' } }, sales.token)).json;
    expect(salesView.totals.count).toBe(2);
    expect((await run({ entity: 'ACCOUNT', columns: ['name'] }, sales.token)).json.rows.map((x: { values: { name: string } }) => x.values.name)).toEqual(['甲客户']);
  });
});

describe('custom reports R1 maintenance', () => {
  it('私有、共享、修改、删除、名称、审计 / private, shared, edit, delete, names, audit', async () => {
    await seed();
    const def = { entity: 'DEAL', groupBy: { field: 'stage' }, chart: 'COLUMN' };
    const mine = await call(reports.POST, { token: sales.token, body: { name: '我的阶段分布', ...def } });
    expect(mine.status).toBe(201);
    expect(mine.json).toMatchObject({ name: '我的阶段分布', shared: false, owner: { id: sales.user.id } });
    expect((await call(reports.POST, { token: sales.token, body: { name: ' 我的阶段分布 ', ...def } })).json.error.details).toEqual({ name: ['taken'] });
    expect((await call(reports.POST, { token: sales.token, body: { name: '共享', ...def, shared: true } })).status).toBe(403);
    const shared = await call(reports.POST, { token: mgr.token, body: { name: '全员阶段分布', description: '经理共享', ...def, shared: true } });
    expect(shared.status).toBe(201);
    // 列表：自己的与共享的 / list: own and shared
    const names = async (token: string) => ((await call(reports.GET, { token })).json.items as { name: string }[]).map((x) => x.name).sort();
    expect(await names(sales.token)).toEqual(['全员阶段分布', '我的阶段分布'].sort());
    expect(await names(a.token)).toEqual(['全员阶段分布']);
    expect((await call(reportItem.GET, { token: a.token, params: { id: mine.json.id } })).status).toBe(404);
    // 共享报表按查看者的范围运行 / shared reports run within the viewer's scope
    expect((await call(runSaved.GET, { token: sales.token, params: { id: shared.json.id } })).json.totals.count).toBe(2);
    expect((await call(runSaved.GET, { token: a.token, params: { id: shared.json.id } })).json.totals.count).toBe(4);
    // 只有创建者能改；对象不可改 / creator-only edits; fixed entity
    const upd = { name: '全员阶段分布（改）', entity: 'DEAL', groupBy: { field: 'ownerId' }, chart: 'BAR', shared: true };
    expect((await call(reportItem.PUT, { token: a.token, params: { id: shared.json.id }, body: upd, method: 'PUT' })).status).toBe(403);
    expect((await call(reportItem.PUT, { token: mgr.token, params: { id: shared.json.id }, body: { ...upd, entity: 'LEAD' }, method: 'PUT' })).json.error.details).toEqual({ entity: ['immutable'] });
    expect((await call(reportItem.PUT, { token: mgr.token, params: { id: shared.json.id }, body: upd, method: 'PUT' })).json).toMatchObject({ name: '全员阶段分布（改）', chart: 'BAR', groupBy: { field: 'ownerId' } });
    // 删除：创建者；共享报表也可由 view.share 持有者删除 / delete: the creator, or view.share holders for shared ones
    expect((await call(reportItem.DELETE, { token: sales.token, params: { id: shared.json.id }, method: 'DELETE' })).status).toBe(403);
    expect((await call(reportItem.DELETE, { token: a.token, params: { id: shared.json.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(reportItem.DELETE, { token: sales.token, params: { id: mine.json.id }, method: 'DELETE' })).status).toBe(204);
    const logs = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entityType: 'report', action: { startsWith: 'customreport.' } }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['customreport.create', 'customreport.create', 'customreport.update', 'customreport.delete', 'customreport.delete']);
    expect(logs[2]!.changes).toMatchObject({ fields: { name: ['全员阶段分布', '全员阶段分布（改）'], chart: ['COLUMN', 'BAR'] } });
  });

  it('导出 CSV 与 Excel（需导出权限，写审计）/ CSV and Excel export', async () => {
    await seed();
    const detail = (await call(reports.POST, { token: a.token, body: { name: '人民币商机', entity: 'DEAL', columns: ['name', 'accountId', 'amount', 'stage'], filters: [{ field: 'currency', op: 'EQUALS', value: 'CNY' }], sort: { field: 'amount', dir: 'asc' } } })).json;
    const summary = (await call(reports.POST, { token: a.token, body: { name: '阶段金额', entity: 'DEAL', groupBy: { field: 'stage' }, filters: [{ field: 'currency', op: 'EQUALS', value: 'CNY' }], measures: [{ fn: 'SUM', field: 'amount' }] } })).json;
    const get = async (id: string, query: Record<string, string> = {}, token = a.token) => {
      const url = new URL('http://localhost/x');
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      const res = await exportRoute.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ id }) });
      return res;
    };
    const csv = await get(detail.id);
    expect(csv.headers.get('x-export-count')).toBe('3');
    const rows = parseCsv(await csv.text());
    expect(rows[0]).toEqual(['商机名称', '关联客户', '商机金额', '销售阶段', '币种']);
    expect(rows[1]).toEqual(['商机一', '甲客户', '1000', '方案报价', 'CNY']);
    const sum = parseCsv(await (await get(summary.id)).text());
    expect(sum[0]).toEqual(['销售阶段', '记录数', '合计 · 商机金额']);
    expect(sum.slice(1)).toEqual([['方案报价', '2', '4000'], ['商务谈判', '1', '2000'], ['合计', '3', '6000']]);
    const xlsx = await get(summary.id, { format: 'xlsx', lang: 'en-US' });
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
    // 有导出权限也看不到他人的私有报表；没有导出权限一律 403 / private reports stay hidden even with export rights; no export right is 403
    expect((await get(detail.id, {}, mgr.token)).status).toBe(404);
    expect((await get(detail.id, {}, sales.token)).status).toBe(403);
    const shared = (await call(reports.POST, { token: a.token, body: { name: '共享导出', entity: 'LEAD', columns: ['name'], shared: true } })).json;
    expect((await get(shared.id, {}, sales.token)).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: 'customreport.export' } })).toBe(3);
  });
});
