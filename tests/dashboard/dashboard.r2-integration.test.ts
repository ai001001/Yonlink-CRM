/**
 * 工作台 第二轮：集成测试（组织隔离、边界、异常输入、与各模块数据一致性）。
 * Dashboard round 2: integration tests (isolation, boundaries, invalid input, consistency with modules).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as activities from '@/app/api/activities/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as search from '@/app/api/search/route';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

const post = async (token: string, h: typeof leads.POST, body: object) => (await call(h, { token, body })).json;

describe('dashboard R2 isolation', () => {
  it('统计、金额、待办、最近跟进只含本组织 / every figure is organization scoped', async () => {
    const accB = await post(b.token, accounts.POST, { name: 'B 客户' });
    await post(b.token, leads.POST, { name: 'B 线索' });
    await post(b.token, deals.POST, { name: 'B 商机', accountId: accB.id, amount: '888' });
    await post(b.token, activities.POST, { type: 'TASK', subject: 'B 待办' });
    const accA = await post(a.token, accounts.POST, { name: 'A 客户' });
    await post(a.token, deals.POST, { name: 'A 商机', accountId: accA.id, amount: '1' });

    const d = (await call(dashboard.GET, { token: a.token })).json;
    expect(d.counts).toEqual({ accounts: 1, leads: 0, deals: 1 });
    expect(d.dealAmounts.all).toEqual([{ currency: 'CNY', amount: '1' }]);
    expect(d.recentActivities).toEqual([]);
    expect(d.myTodos).toEqual([]);
    expect(d.stages).toEqual([{ stage: 'QUALIFICATION', currency: 'CNY', count: 1, amount: '1' }]);
  });

  it('全局搜索不返回其他组织数据 / global search never returns other orgs', async () => {
    const accB = await post(b.token, accounts.POST, { name: '机密客户' });
    await post(b.token, leads.POST, { name: '机密线索' });
    await post(b.token, deals.POST, { name: '机密商机', accountId: accB.id });
    const r = (await call(search.GET, { token: a.token, query: { q: '机密' } })).json;
    expect(r).toEqual({ leads: [], accounts: [], deals: [] });
  });

  it('未登录 401 / unauthenticated → 401', async () => {
    expect((await call(dashboard.GET)).status).toBe(401);
    expect((await call(search.GET, { query: { q: 'x' } })).status).toBe(401);
  });
});

describe('dashboard R2 consistency & boundaries', () => {
  it('工作台金额与商机列表合计一致 / dashboard totals equal the deals list totals', async () => {
    const acc = await post(a.token, accounts.POST, { name: '客户' });
    for (const amount of ['0.01', '0.02', '9999999999999999.99', '123.45']) {
      await post(a.token, deals.POST, { name: amount, amount, accountId: acc.id });
    }
    const d = (await call(dashboard.GET, { token: a.token })).json;
    const list = (await call(deals.GET, { token: a.token })).json;
    expect(d.dealAmounts.all).toEqual(list.sums);
    // 超出 JS 浮点精度的金额仍精确 / exact beyond JS float precision
    expect(d.dealAmounts.all[0].amount).toBe('10000000000000123.47');
  });

  it('删除客户后数量与最近跟进同步更新 / deleting an account updates counts and recent activities', async () => {
    const acc = await post(a.token, accounts.POST, { name: '待删客户' });
    await post(a.token, activities.POST, { type: 'VISIT', subject: '拜访', accountId: acc.id });
    expect((await call(dashboard.GET, { token: a.token })).json.recentActivities).toHaveLength(1);
    await call(accountItem.DELETE, { token: a.token, method: 'DELETE', params: { id: acc.id } });
    const d = (await call(dashboard.GET, { token: a.token })).json;
    expect(d.counts.accounts).toBe(0);
    expect(d.recentActivities).toHaveLength(0);
  });

  it('待办最多返回 10 条，但总数准确 / to-do list capped at 10 with accurate total', async () => {
    for (let i = 0; i < 13; i++) await post(a.token, activities.POST, { type: 'TASK', subject: `任务${i}` });
    const d = (await call(dashboard.GET, { token: a.token })).json;
    expect(d.myTodos).toHaveLength(10);
    expect(d.myTodoCount).toBe(13);
  });

  it.each([[{}], [{ q: '' }], [{ q: '   ' }], [{ q: 'x'.repeat(101) }]])('非法搜索参数 %j → 400', async (query) => {
    expect((await call(search.GET, { token: a.token, query })).status).toBe(400);
  });

  it('搜索通配符按字面处理，每类最多 10 条 / wildcards literal, at most 10 per type', async () => {
    for (let i = 0; i < 12; i++) await post(a.token, leads.POST, { name: `批量线索${i}` });
    expect((await call(search.GET, { token: a.token, query: { q: '%' } })).json.leads).toHaveLength(0);
    expect((await call(search.GET, { token: a.token, query: { q: '批量' } })).json.leads).toHaveLength(10);
  });
});
