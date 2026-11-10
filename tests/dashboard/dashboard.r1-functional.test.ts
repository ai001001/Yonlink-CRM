/**
 * 工作台 第一轮：功能测试（统计来自数据库真实数据）+ 全局搜索。
 * Dashboard round 1: functional tests (figures come from real DB data) + global search.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as activities from '@/app/api/activities/route';
import * as activityItem from '@/app/api/activities/[id]/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as search from '@/app/api/search/route';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

const get = async () => (await call(dashboard.GET, { token: a.token })).json;
const post = async (h: typeof leads.POST, body: object) => (await call(h, { token: a.token, body })).json;

describe('dashboard R1 functional', () => {
  it('空组织：全部为 0 / empty organization shows zeros', async () => {
    const d = await get();
    expect(d).toMatchObject({
      counts: { accounts: 0, leads: 0, deals: 0 },
      dealAmounts: { all: [], open: [], won: [] },
      stages: [],
      recentActivities: [],
      myTodos: [],
      myTodoCount: 0,
      myOverdueCount: 0,
    });
  });

  it('客户、线索、商机数量随增删实时变化 / counts follow creates and deletes', async () => {
    const acc = await post(accounts.POST, { name: '客户一' });
    await post(accounts.POST, { name: '客户二' });
    for (const name of ['线索一', '线索二', '线索三']) await post(leads.POST, { name });
    const deal = await post(deals.POST, { name: '商机一', accountId: acc.id });
    expect((await get()).counts).toEqual({ accounts: 2, leads: 3, deals: 1 });
    await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: deal.id } });
    expect((await get()).counts.deals).toBe(0);
  });

  it('商机金额汇总：全部 / 进行中 / 赢单，按币种精确合计 / exact amount totals per currency', async () => {
    const acc = await post(accounts.POST, { name: '客户' });
    const mk = (name: string, amount: string, stage: string, currency = 'CNY') =>
      post(deals.POST, { name, amount, stage, currency, accountId: acc.id });
    await mk('甲', '100.10', 'QUALIFICATION');
    await mk('乙', '200.20', 'NEGOTIATION');
    await mk('丙', '300.30', 'CLOSED_WON');
    await mk('丁', '999.99', 'CLOSED_LOST');
    await mk('戊', '50', 'PROPOSAL', 'USD');
    const d = await get();
    expect(d.dealAmounts.all).toEqual([
      { currency: 'CNY', amount: '1600.59' },
      { currency: 'USD', amount: '50' },
    ]);
    expect(d.dealAmounts.open).toEqual([
      { currency: 'CNY', amount: '300.3' },
      { currency: 'USD', amount: '50' },
    ]);
    expect(d.dealAmounts.won).toEqual([{ currency: 'CNY', amount: '300.3' }]);
    const stage = (s: string) => d.stages.find((x: { stage: string }) => x.stage === s);
    expect(stage('CLOSED_LOST')).toEqual({ stage: 'CLOSED_LOST', currency: 'CNY', count: 1, amount: '999.99' });
    expect(d.stages).toHaveLength(5);
  });

  it('最近跟进记录：最新 10 条，最新在前，含关联名称 / recent activities: latest 10, newest first', async () => {
    const acc = await post(accounts.POST, { name: '钟山客户' });
    for (let i = 1; i <= 12; i++) await post(activities.POST, { type: 'CALL', subject: `跟进${i}`, accountId: acc.id, completed: true });
    const d = await get();
    expect(d.recentActivities).toHaveLength(10);
    expect(d.recentActivities[0].subject).toBe('跟进12');
    expect(d.recentActivities[0].account.name).toBe('钟山客户');
  });

  it('我的待办：只含本人未完成事项，按截止时间排序，统计逾期 / my to-dos: mine, pending, sorted, overdue counted', async () => {
    const colleague = await createTenant('A2');
    // 同组织同事 / move the colleague into my organization
    const { prisma } = await import('@/server/db');
    await prisma.user.update({ where: { id: colleague.user.id }, data: { organizationId: a.org.id } });
    await post(activities.POST, { type: 'TASK', subject: '逾期任务', dueAt: '2020-01-01T00:00:00Z' });
    await post(activities.POST, { type: 'TASK', subject: '未来任务', dueAt: '2099-01-01T00:00:00Z' });
    await post(activities.POST, { type: 'MEETING', subject: '无截止会议' });
    await post(activities.POST, { type: 'TASK', subject: '已完成', completed: true });
    await post(activities.POST, { type: 'TASK', subject: '同事的任务', ownerId: colleague.user.id });
    const d = await get();
    expect(d.myTodos.map((x: { subject: string }) => x.subject)).toEqual(['逾期任务', '未来任务', '无截止会议']);
    expect(d.myTodoCount).toBe(3);
    expect(d.myOverdueCount).toBe(1);
    expect(d.recentActivities).toHaveLength(5);

    const done = d.myTodos[0];
    await call(activityItem.PATCH, { token: a.token, method: 'PATCH', params: { id: done.id }, body: { completed: true } });
    const after = await get();
    expect(after.myTodoCount).toBe(2);
    expect(after.myOverdueCount).toBe(0);
  });
});

describe('global search R1 functional', () => {
  it('跨线索、客户（含联系人）、商机搜索 / search across leads, accounts (incl. contacts) and deals', async () => {
    const acc = await post(accounts.POST, { name: '星海贸易' });
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '星辰' } });
    await post(leads.POST, { name: '王星', company: '其他公司' });
    await post(deals.POST, { name: '年度合同', accountId: acc.id, amount: '10' });
    await post(leads.POST, { name: '无关线索' });
    const r = (await call(search.GET, { token: a.token, query: { q: '星' } })).json;
    expect(r.leads.map((x: { name: string }) => x.name)).toEqual(['王星']);
    expect(r.accounts.map((x: { name: string }) => x.name)).toEqual(['星海贸易']);
    expect(r.deals.map((x: { name: string }) => x.name)).toEqual(['年度合同']);
    const byContact = (await call(search.GET, { token: a.token, query: { q: '星辰' } })).json;
    expect(byContact.accounts).toHaveLength(1);
  });
});
