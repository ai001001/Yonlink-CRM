/**
 * 批量操作 第一轮：功能测试（四个模块的全部批量动作、去重、逐条审计）。
 * Bulk actions round 1: functional tests (every action of the four modules, dedupe, per-record audit).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountBulk from '@/app/api/accounts/bulk/route';
import * as activities from '@/app/api/activities/route';
import * as activityBulk from '@/app/api/activities/bulk/route';
import * as deals from '@/app/api/deals/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as leads from '@/app/api/leads/route';
import * as leadBulk from '@/app/api/leads/bulk/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let colleague: Awaited<ReturnType<typeof addUser>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  colleague = await addUser(a.org.id, 'SALES', 'S1');
});

const mk = async (h: typeof leads.POST, body: object) => (await call(h, { token: a.token, body })).json;
const mkLeads = async (n: number) => Promise.all(Array.from({ length: n }, (_, i) => mk(leads.POST, { name: `线索${i}` })));

describe('bulk R1 leads', () => {
  it('批量指派负责人 / assign owner', async () => {
    const ls = await mkLeads(3);
    const res = await call(leadBulk.POST, { token: a.token, body: { action: 'assign', ids: ls.map((l) => l.id), ownerId: colleague.user.id } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ succeeded: ls.map((l) => l.id), failed: [] });
    expect(await prisma.lead.count({ where: { ownerId: colleague.user.id } })).toBe(3);
  });

  it('批量取消分配（ownerId 为 null）/ unassign with null', async () => {
    const ls = await mkLeads(2);
    await call(leadBulk.POST, { token: a.token, body: { action: 'assign', ids: ls.map((l) => l.id), ownerId: null } });
    expect(await prisma.lead.count({ where: { ownerId: null } })).toBe(2);
  });

  it('批量修改状态 / change status', async () => {
    const ls = await mkLeads(4);
    const res = await call(leadBulk.POST, { token: a.token, body: { action: 'status', ids: ls.map((l) => l.id), status: 'QUALIFIED' } });
    expect(res.json.succeeded).toHaveLength(4);
    expect(await prisma.lead.count({ where: { status: 'QUALIFIED' } })).toBe(4);
  });

  it('批量删除 / delete', async () => {
    const ls = await mkLeads(3);
    const res = await call(leadBulk.POST, { token: a.token, body: { action: 'delete', ids: ls.slice(0, 2).map((l) => l.id) } });
    expect(res.json.succeeded).toHaveLength(2);
    expect(await prisma.lead.count()).toBe(1);
  });

  it('重复 ID 自动去重 / duplicate ids are processed once', async () => {
    const [l] = await mkLeads(1);
    const res = await call(leadBulk.POST, { token: a.token, body: { action: 'status', ids: [l.id, l.id, l.id], status: 'CONTACTED' } });
    expect(res.json).toEqual({ succeeded: [l.id], failed: [] });
    expect(await prisma.auditLog.count({ where: { action: 'lead.update', entityId: l.id } })).toBe(1);
  });

  it('每条记录写一条审计 / one audit entry per record', async () => {
    const ls = await mkLeads(3);
    await call(leadBulk.POST, { token: a.token, body: { action: 'status', ids: ls.map((l) => l.id), status: 'CONTACTED' } });
    const logs = await prisma.auditLog.findMany({ where: { action: 'lead.update' } });
    expect(logs.map((l) => l.entityId).sort()).toEqual(ls.map((l) => l.id).sort());
    for (const log of logs) expect(log.changes).toEqual({ fields: { status: ['NEW', 'CONTACTED'] } });
  });
});

describe('bulk R1 accounts, deals, activities', () => {
  it('客户：批量指派与删除 / accounts assign and delete', async () => {
    const accs = await Promise.all([mk(accounts.POST, { name: '甲' }), mk(accounts.POST, { name: '乙' })]);
    const ids = accs.map((x) => x.id);
    expect((await call(accountBulk.POST, { token: a.token, body: { action: 'assign', ids, ownerId: colleague.user.id } })).json.succeeded).toHaveLength(2);
    expect(await prisma.account.count({ where: { ownerId: colleague.user.id } })).toBe(2);
    expect((await call(accountBulk.POST, { token: a.token, body: { action: 'delete', ids } })).json.succeeded).toHaveLength(2);
    expect(await prisma.account.count()).toBe(0);
  });

  it('商机：批量改阶段、指派、删除 / deals stage, assign, delete', async () => {
    const acc = await mk(accounts.POST, { name: '客户' });
    const ds = await Promise.all([mk(deals.POST, { name: 'd1', accountId: acc.id }), mk(deals.POST, { name: 'd2', accountId: acc.id })]);
    const ids = ds.map((d) => d.id);
    await call(dealBulk.POST, { token: a.token, body: { action: 'stage', ids, stage: 'NEGOTIATION' } });
    expect(await prisma.deal.count({ where: { stage: 'NEGOTIATION' } })).toBe(2);
    await call(dealBulk.POST, { token: a.token, body: { action: 'assign', ids, ownerId: colleague.user.id } });
    expect(await prisma.deal.count({ where: { ownerId: colleague.user.id } })).toBe(2);
    await call(dealBulk.POST, { token: a.token, body: { action: 'delete', ids } });
    expect(await prisma.deal.count()).toBe(0);
  });

  it('跟进：批量完成、重新打开、删除 / activities complete, reopen, delete', async () => {
    const acts = await Promise.all([mk(activities.POST, { type: 'TASK', subject: 't1' }), mk(activities.POST, { type: 'TASK', subject: 't2' })]);
    const ids = acts.map((x) => x.id);
    await call(activityBulk.POST, { token: a.token, body: { action: 'complete', ids, completed: true } });
    const done = await prisma.activity.findMany();
    for (const x of done) expect([x.completed, x.completedAt !== null]).toEqual([true, true]);
    await call(activityBulk.POST, { token: a.token, body: { action: 'complete', ids, completed: false } });
    expect(await prisma.activity.count({ where: { completed: false, completedAt: null } })).toBe(2);
    await call(activityBulk.POST, { token: a.token, body: { action: 'delete', ids } });
    expect(await prisma.activity.count()).toBe(0);
  });
});
