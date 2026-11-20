/**
 * 定时工作流 第一轮：功能测试（规则校验：相对日期须有日期字段与天数、无跟进须有天数；即时写入不触发定时规则；
 * 相对日期：预计成交日前 N 天、创建日后 N 天、只执行一次、日期改了再触发、补做上限 7 天、规则创建前的触发日不补、
 * 触发时条件不满足则该键不再检查；无跟进：达到天数触发、新跟进后重新计时、已转化线索与已结束商机跳过；
 * 动作以系统身份执行、执行次数与审计；列表返回天数）。
 * Scheduled workflows round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { sweepScheduledWorkflows } from '@/server/modules/workflow-schedule';
import { addUser, call, createTenant, resetDb } from '../helpers';

const DAY = 86_400_000;
const day = (offset: number, from = Date.now()) => new Date(from + offset * DAY).toISOString().slice(0, 10);

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let acc: { id: string };
const rule = (body: object) => call(workflows.POST, { token: a.token, body: { name: '定时', actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '提醒' }], ...body } });
const notes = (id: string) => prisma.notification.count({ where: { OR: [{ dealId: id }, { leadId: id }], type: 'WORKFLOW' } });
/** 把规则创建时间提前，便于测试过去的触发日 / backdate the rule so past trigger days are eligible */
const backdate = (id: string, days: number) => prisma.workflowRule.update({ where: { id }, data: { createdAt: new Date(Date.now() - days * DAY) } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', ownerId: rep.user.id } })).json;
});

describe('scheduled workflows R1 validation', () => {
  it('相对日期与无跟进的字段、天数校验；即时写入不触发 / validation and no instant firing', async () => {
    const bad: object[] = [
      { entity: 'DEAL', trigger: 'DATE_RELATIVE', triggerDays: -3 },
      { entity: 'DEAL', trigger: 'DATE_RELATIVE', triggerField: 'stage', triggerDays: -3 },
      { entity: 'LEAD', trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate', triggerDays: 1 },
      { entity: 'DEAL', trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate' },
      { entity: 'DEAL', trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate', triggerDays: 400 },
      { entity: 'LEAD', trigger: 'INACTIVITY' },
      { entity: 'LEAD', trigger: 'INACTIVITY', triggerDays: 0 },
      { entity: 'LEAD', trigger: 'INACTIVITY', triggerDays: 3, triggerField: 'createdAt' },
      { entity: 'LEAD', trigger: 'CREATE', triggerDays: 3 },
      { entity: 'LEAD', trigger: 'INACTIVITY', triggerDays: 2.5 },
    ];
    for (const body of bad) expect((await rule(body)).status, JSON.stringify(body)).toBe(400);
    const ok = await rule({ entity: 'DEAL', trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate', triggerDays: -3 });
    expect(ok.json).toMatchObject({ trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate', triggerDays: -3 });
    expect((await rule({ name: '无跟进', entity: 'LEAD', trigger: 'INACTIVITY', triggerDays: 7 })).json.triggerDays).toBe(7);
    // 即时写入不触发定时规则 / instant writes never fire scheduled rules
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, expectedCloseDate: day(3) } })).json;
    await call(leads.POST, { token: a.token, body: { name: '线索' } });
    expect(await prisma.auditLog.count({ where: { action: 'workflow.run' } })).toBe(0);
    expect(await notes(deal.id)).toBe(0);
  });
});

describe('scheduled workflows R1 relative dates', () => {
  it('预计成交日前 3 天：只执行一次、日期改了再触发、条件与系统身份 / before the close date', async () => {
    const r = (await rule({ entity: 'DEAL', trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate', triggerDays: -3, conditions: [{ field: 'stage', op: 'NOT_EQUALS', value: 'CLOSED_WON' }] })).json;
    const due = (await call(deals.POST, { token: a.token, body: { name: '三天后成交', accountId: acc.id, expectedCloseDate: day(3), ownerId: rep.user.id } })).json;
    const later = (await call(deals.POST, { token: a.token, body: { name: '十天后成交', accountId: acc.id, expectedCloseDate: day(10) } })).json;
    const won = (await call(deals.POST, { token: a.token, body: { name: '已赢单', accountId: acc.id, expectedCloseDate: day(3), stage: 'CLOSED_WON' } })).json;
    const first = await sweepScheduledWorkflows();
    expect(first).toMatchObject({ rules: 1, checked: 2, ran: 1, failures: [] });
    expect([await notes(due.id), await notes(later.id), await notes(won.id)]).toEqual([1, 0, 0]);
    const n = await prisma.notification.findFirstOrThrow({ where: { dealId: due.id, type: 'WORKFLOW' } });
    expect(n).toMatchObject({ userId: rep.user.id, actorId: null, title: '提醒 · 三天后成交' });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'workflow.run' } })).actorId).toBeNull();
    // 再次运行不重复；赢单商机的键已登记，改回进行中也不再触发 / no repeats; the won deal's key is used up
    await call(dealItem.PATCH, { token: a.token, params: { id: won.id }, body: { stage: 'NEGOTIATION' }, method: 'PATCH' });
    expect((await sweepScheduledWorkflows()).ran).toBe(0);
    // 7 天后：十天后成交的到期 / seven days later the 10-day deal is due
    expect((await sweepScheduledWorkflows({ now: new Date(Date.now() + 7 * DAY) })).ran).toBe(1);
    expect(await notes(later.id)).toBe(1);
    // 日期改了：按新日期再触发 / a changed date triggers again
    await call(dealItem.PATCH, { token: a.token, params: { id: due.id }, body: { expectedCloseDate: day(5) }, method: 'PATCH' });
    expect((await sweepScheduledWorkflows({ now: new Date(Date.now() + 2 * DAY) })).ran).toBe(1);
    expect(await notes(due.id)).toBe(2);
    expect((await prisma.workflowRule.findUniqueOrThrow({ where: { id: r.id } })).runCount).toBe(3);
  });

  it('创建日后 N 天；补做上限 7 天；规则创建前的触发日不补 / after creation, catch-up limits', async () => {
    const r = (await rule({ entity: 'LEAD', trigger: 'DATE_RELATIVE', triggerField: 'createdAt', triggerDays: 2 })).json;
    const lead = (await call(leads.POST, { token: a.token, body: { name: '两天后提醒' } })).json;
    expect((await sweepScheduledWorkflows()).ran).toBe(0);
    expect((await sweepScheduledWorkflows({ now: new Date(Date.now() + 2 * DAY) })).ran).toBe(1);
    expect(await notes(lead.id)).toBe(1);
    // 触发日早于规则创建日：不补 / trigger day before the rule existed: skipped
    const old = (await call(leads.POST, { token: a.token, body: { name: '老线索' } })).json;
    await prisma.$executeRaw`UPDATE leads SET created_at = now() - interval '5 days' WHERE id = ${old.id}::uuid`;
    expect((await sweepScheduledWorkflows()).ran).toBe(0);
    // 规则早已存在：5 天前创建、触发日 3 天前 → 补做；20 天前的超过 7 天 → 不补 / within / beyond the 7-day catch-up
    await backdate(r.id, 30);
    const stale = (await call(leads.POST, { token: a.token, body: { name: '很老的线索' } })).json;
    await prisma.$executeRaw`UPDATE leads SET created_at = now() - interval '20 days' WHERE id = ${stale.id}::uuid`;
    expect((await sweepScheduledWorkflows()).ran).toBe(1);
    expect([await notes(old.id), await notes(stale.id)]).toEqual([1, 0]);
  });
});

describe('scheduled workflows R1 inactivity', () => {
  it('无跟进：达到天数触发、新跟进重新计时、已转化线索与已结束商机跳过 / inactivity', async () => {
    await rule({ entity: 'LEAD', trigger: 'INACTIVITY', triggerDays: 7 });
    await rule({ name: '商机无跟进', entity: 'DEAL', trigger: 'INACTIVITY', triggerDays: 7 });
    const lead = (await call(leads.POST, { token: a.token, body: { name: '沉默线索' } })).json;
    const converted = (await call(leads.POST, { token: a.token, body: { name: '已转化' } })).json;
    const open = (await call(deals.POST, { token: a.token, body: { name: '沉默商机', accountId: acc.id } })).json;
    const closed = (await call(deals.POST, { token: a.token, body: { name: '已输单', accountId: acc.id, stage: 'CLOSED_LOST' } })).json;
    await prisma.$executeRaw`UPDATE leads SET created_at = now() - interval '10 days' WHERE organization_id = ${a.org.id}::uuid`;
    await prisma.$executeRaw`UPDATE deals SET created_at = now() - interval '10 days' WHERE organization_id = ${a.org.id}::uuid`;
    await prisma.lead.update({ where: { id: converted.id }, data: { status: 'CONVERTED', convertedAt: new Date() } });
    expect((await sweepScheduledWorkflows()).ran).toBe(2);
    expect([await notes(lead.id), await notes(converted.id), await notes(open.id), await notes(closed.id)]).toEqual([1, 0, 1, 0]);
    expect((await sweepScheduledWorkflows()).ran).toBe(0);
    // 新跟进：重新计时，8 天后再提醒 / a new activity restarts the clock
    expect((await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '回访', leadId: lead.id } })).status).toBe(201);
    expect((await sweepScheduledWorkflows({ now: new Date(Date.now() + 3 * DAY) })).ran).toBe(0);
    expect((await sweepScheduledWorkflows({ now: new Date(Date.now() + 8 * DAY) })).ran).toBe(1);
    expect(await notes(lead.id)).toBe(2);
    // 列表返回天数 / the list returns the days
    const list = (await call(workflows.GET, { token: a.token })).json.items;
    expect(list.map((x: { triggerDays: number }) => x.triggerDays).sort()).toEqual([7, 7]);
  });
});
