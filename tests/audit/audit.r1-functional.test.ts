/**
 * 审计日志 第一轮：功能测试（各模块写操作与登录事件均被记录，查询与筛选）。
 * Audit log round 1: functional tests (every module write and auth event is recorded; query & filters).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as activities from '@/app/api/activities/route';
import * as activityItem from '@/app/api/activities/[id]/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as loginRoute from '@/app/api/auth/login/route';
import * as logoutRoute from '@/app/api/auth/logout/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

const HDR = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'Vitest-Agent/1.0' };
const logs = () => prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
const actions = async () => (await logs()).map((l) => l.action);

describe('audit R1: business writes are recorded', () => {
  it('线索新建/修改/删除：操作人、对象、IP、UA 与变更内容 / lead create/update/delete', async () => {
    const lead = (await call(leads.POST, { token: a.token, headers: HDR, body: { name: '张三', company: '星河', status: 'NEW' } })).json;
    await call(leadItem.PATCH, { token: a.token, method: 'PATCH', params: { id: lead.id }, body: { status: 'CONTACTED', company: '星河集团' } });
    await call(leadItem.DELETE, { token: a.token, method: 'DELETE', params: { id: lead.id } });
    const rows = await logs();
    expect(rows.map((r) => r.action)).toEqual(['lead.create', 'lead.update', 'lead.delete']);
    for (const r of rows) expect(r).toMatchObject({ organizationId: a.org.id, actorId: a.user.id, entityType: 'lead', entityId: lead.id });
    expect(rows[0]).toMatchObject({ ip: '203.0.113.7', userAgent: 'Vitest-Agent/1.0' });
    expect(rows[0]!.changes).toMatchObject({ after: { name: '张三', company: '星河', status: 'NEW', ownerId: a.user.id } });
    expect(rows[1]!.changes).toEqual({ fields: { status: ['NEW', 'CONTACTED'], company: ['星河', '星河集团'] } });
    expect(rows[2]!.changes).toMatchObject({ before: { name: '张三', company: '星河集团' } });
  });

  it('无实际变化的更新不写日志 / no-op updates are not logged', async () => {
    const lead = (await call(leads.POST, { token: a.token, body: { name: '张三' } })).json;
    await call(leadItem.PATCH, { token: a.token, method: 'PATCH', params: { id: lead.id }, body: { name: '张三' } });
    expect(await actions()).toEqual(['lead.create']);
  });

  it('客户、联系人、商机、跟进的增删改都被记录 / accounts, contacts, deals, activities', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    await call(accountItem.PATCH, { token: a.token, method: 'PATCH', params: { id: acc.id }, body: { industry: 'IT' } });
    const c = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '陈' } })).json;
    await call(contactItem.PATCH, { token: a.token, method: 'PATCH', params: { id: c.id }, body: { title: '经理' } });
    await call(contactItem.DELETE, { token: a.token, method: 'DELETE', params: { id: c.id } });
    const d = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, amount: '100.50' } })).json;
    await call(dealItem.PATCH, { token: a.token, method: 'PATCH', params: { id: d.id }, body: { amount: '200', stage: 'PROPOSAL' } });
    const act = (await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '电话', dealId: d.id } })).json;
    await call(activityItem.PATCH, { token: a.token, method: 'PATCH', params: { id: act.id }, body: { completed: true } });
    await call(activityItem.DELETE, { token: a.token, method: 'DELETE', params: { id: act.id } });
    await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: d.id } });
    await call(accountItem.DELETE, { token: a.token, method: 'DELETE', params: { id: acc.id } });
    expect(await actions()).toEqual([
      'account.create', 'account.update',
      'contact.create', 'contact.update', 'contact.delete',
      'deal.create', 'deal.update',
      'activity.create', 'activity.update', 'activity.delete',
      'deal.delete', 'account.delete',
    ]);
    const dealUpdate = (await logs()).find((l) => l.action === 'deal.update')!;
    expect(dealUpdate.changes).toEqual({ fields: { amount: ['100.5', '200'], stage: ['QUALIFICATION', 'PROPOSAL'] } });
    const done = (await logs()).find((l) => l.action === 'activity.update')!;
    expect(done.changes).toEqual({ fields: { completed: [false, true] } });
  });

  it('线索转化：转化事件及其创建的客户/联系人/商机均有记录 / conversion and created records', async () => {
    const lead = (await call(leads.POST, { token: a.token, body: { name: '张三', company: '星河' } })).json;
    const res = (await call(convert.POST, { token: a.token, params: { id: lead.id }, body: { account: { mode: 'new' }, deal: { name: 'd' } } })).json;
    const rows = await logs();
    expect(rows.map((r) => r.action)).toEqual(['lead.create', 'account.create', 'contact.create', 'deal.create', 'lead.convert']);
    expect(rows[1]!.changes).toMatchObject({ via: 'lead.convert', after: { name: '星河' } });
    expect(rows[4]!.changes).toEqual({ accountMode: 'new', accountId: res.account.id, contactId: res.contact.id, dealId: res.deal.id });
    // 同一事务内的记录时间严格递增，排序可靠 / entries from one transaction have strictly increasing times
    const times = rows.slice(1).map((r) => r.createdAt.getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    const raw = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT created_at) AS n FROM audit_logs WHERE action <> 'lead.create'`;
    expect(Number(raw[0]!.n)).toBe(4);
  });
});

describe('audit R1: auth events', () => {
  it('登录成功、失败（密码错误）与退出均被记录，失败原因不含密码 / login, failed login and logout', async () => {
    const ok = await call(loginRoute.POST, { headers: HDR, body: { email: a.user.email, password: a.password } });
    await call(loginRoute.POST, { body: { email: a.user.email, password: 'wrong-secret-xyz' } });
    await call(logoutRoute.POST, { token: ok.json.token, method: 'POST' });
    const rows = await logs();
    expect(rows.map((r) => r.action)).toEqual(['auth.login', 'auth.login_failed', 'auth.logout']);
    expect(rows[0]).toMatchObject({ actorId: a.user.id, entityType: 'auth', ip: '203.0.113.7' });
    expect(rows[1]!.changes).toEqual({ reason: 'bad_password' });
    expect(JSON.stringify(rows)).not.toContain('wrong-secret-xyz');
    expect(JSON.stringify(rows)).not.toContain(ok.json.token);
  });

  it('停用账号登录失败原因为 inactive / inactive account reason', async () => {
    await prisma.user.update({ where: { id: a.user.id }, data: { isActive: false } });
    await call(loginRoute.POST, { body: { email: a.user.email, password: a.password } });
    expect((await logs())[0]!.changes).toEqual({ reason: 'inactive' });
  });
});

describe('audit R1: query API', () => {
  it('按对象、对象 ID、操作、操作人、时间筛选并分页，最新在前 / filters and paging', async () => {
    const l1 = (await call(leads.POST, { token: a.token, body: { name: '一' } })).json;
    await call(leads.POST, { token: a.token, body: { name: '二' } });
    await call(accounts.POST, { token: a.token, body: { name: '客户' } });
    await call(leadItem.PATCH, { token: a.token, method: 'PATCH', params: { id: l1.id }, body: { name: '一改' } });
    const q = async (query: Record<string, string>) => (await call(auditLogs.GET, { token: a.token, query })).json;

    const all = await q({});
    expect(all.total).toBe(4);
    expect(all.items[0].action).toBe('lead.update');
    expect(all.items[0].actor).toEqual({ id: a.user.id, name: a.user.name });
    expect((await q({ entityType: 'account' })).total).toBe(1);
    expect((await q({ entityType: 'lead', entityId: l1.id })).items.map((i: { action: string }) => i.action)).toEqual(['lead.update', 'lead.create']);
    expect((await q({ action: 'lead.create' })).total).toBe(2);
    expect((await q({ actorId: a.user.id })).total).toBe(4);
    expect((await q({ from: '2000-01-01T00:00:00Z', to: '2000-01-02T00:00:00Z' })).total).toBe(0);
    expect((await q({ from: new Date(Date.now() - 60_000).toISOString() })).total).toBe(4);
    const p2 = await q({ page: '2', pageSize: '3' });
    expect(p2.items).toHaveLength(1);
  });
});
