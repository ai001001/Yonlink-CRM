/**
 * 销售节奏 第一轮：功能测试（维护：校验、同名、上限、对象不可改、改步骤重算、删除、权限、审计；
 * 加入：第 0 天立即创建、重复加入、已转化、退出状态、停用节奏、可见与权限；
 * 执行：按天数创建跟进、补建错过的步骤、完成、进入退出状态与转化时退出、停用暂停、停止、负责人缺失时给加入人、审计）。
 * Cadences round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as cadenceEnroll from '@/app/api/cadences/[id]/enroll/route';
import * as cadenceItem from '@/app/api/cadences/[id]/route';
import * as cadences from '@/app/api/cadences/route';
import * as enrollments from '@/app/api/cadence-enrollments/route';
import * as stop from '@/app/api/cadence-enrollments/[id]/stop/route';
import * as deals from '@/app/api/deals/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import { prisma } from '@/server/db';
import { MAX_CADENCES, sweepCadences } from '@/server/modules/cadences';
import { addUser, call, createTenant, resetDb } from '../helpers';

const DAY = 86_400_000;
let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;
const STEPS = [
  { day: 0, type: 'CALL', subject: '首次电话' },
  { day: 2, type: 'TASK', subject: '发目录' },
  { day: 5, type: 'CALL', subject: '回访' },
  { day: 7, type: 'VISIT', subject: '拜访' },
];
const newCadence = (body: object, token = a.token) => call(cadences.POST, { token, body: { name: '节奏', entity: 'LEAD', steps: STEPS, exitStates: ['QUALIFIED'], ...body } });
const patchCadence = (id: string, body: object, token = a.token) => call(cadenceItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const enroll = (id: string, ids: string[], token = a.token) => call(cadenceEnroll.POST, { token, params: { id }, body: { ids } });
const newLead = async (body: object = {}, token = a.token) => (await call(leads.POST, { token, body: { name: '线索', ...body } })).json;
const later = (days: number) => new Date(Date.now() + days * DAY + 60_000);
const subjects = async (leadId: string) => (await prisma.activity.findMany({ where: { leadId }, orderBy: [{ createdAt: 'asc' }, { subject: 'asc' }] })).map((x) => x.subject);
const enrollmentOf = (leadId: string) => prisma.cadenceEnrollment.findFirstOrThrow({ where: { leadId }, orderBy: { enrolledAt: 'desc' } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('cadences R1 maintenance', () => {
  it('校验、同名、权限、对象不可改、删除、审计、上限 / maintenance', async () => {
    const r = await newCadence({}, mgr.token);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '节奏', entity: 'LEAD', isActive: true, steps: STEPS, exitStates: ['QUALIFIED'] });
    const bad: object[] = [
      { name: ' ' },
      { steps: [] },
      { steps: Array.from({ length: 11 }, (_, i) => ({ day: i, type: 'TASK', subject: 's' })) },
      { steps: [STEPS[1], STEPS[0]] },
      { steps: [{ day: 366, type: 'TASK', subject: 's' }] },
      { steps: [{ day: 1, type: 'EMAIL', subject: 's' }] },
      { steps: [{ day: 1, type: 'TASK', subject: ' ' }] },
      { exitStates: ['PROPOSAL'] },
      { exitStates: ['CONVERTED'] },
      { exitStates: ['QUALIFIED', 'QUALIFIED'] },
      { entity: 'ACCOUNT' },
      { entity: 'DEAL', exitStates: ['QUALIFIED'] },
    ];
    for (const [i, body] of bad.entries()) expect((await newCadence({ name: `非法${i}`, ...body })).status, JSON.stringify(body)).toBe(400);
    expect((await newCadence({ name: ' 节奏 ' })).json.error.details).toEqual({ name: ['taken'] });
    expect((await newCadence({ name: '销售建' }, sales.token)).status).toBe(403);
    expect((await call(cadences.GET, { token: sales.token })).json.items[0]).toMatchObject({ name: '节奏', counts: { active: 0, completed: 0, exited: 0, stopped: 0 } });
    expect((await patchCadence(r.json.id, { entity: 'DEAL', steps: STEPS, exitStates: [] })).json.error.details).toEqual({ entity: ['immutable'] });
    expect((await patchCadence(r.json.id, { steps: STEPS })).json.error.details).toEqual({ entity: ['required'] });
    expect((await patchCadence(r.json.id, { name: '改名' }, sales.token)).status).toBe(403);
    expect((await patchCadence(r.json.id, { name: '节奏2', isActive: false })).json).toMatchObject({ name: '节奏2', isActive: false });
    // 删除：参与随之删除，已创建的跟进保留 / delete: enrollments go, activities stay
    await patchCadence(r.json.id, { isActive: true });
    const l = await newLead();
    await enroll(r.json.id, [l.id]);
    expect((await call(cadenceItem.DELETE, { token: a.token, params: { id: r.json.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.cadenceEnrollment.count()).toBe(0);
    expect(await subjects(l.id)).toEqual(['首次电话']);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'cadence' } })).json.items as { action: string; changes: Record<string, unknown> }[];
    expect(logs.map((x) => x.action).sort()).toEqual(['cadence.create', 'cadence.delete', 'cadence.enroll', 'cadence.update', 'cadence.update']);
    expect(logs.find((x) => x.action === 'cadence.delete')!.changes.enrollments).toBe(1);
    await prisma.cadence.createMany({ data: Array.from({ length: MAX_CADENCES }, (_, i) => ({ organizationId: a.org.id, name: `批量${i}`, entity: 'LEAD', steps: STEPS, createdById: a.user.id })) });
    expect((await newCadence({ name: '第51个' })).json.error.details).toEqual({ name: ['limit_reached'] });
  });
});

describe('cadences R1 enroll and run', () => {
  it('加入：第 0 天立即创建；按天数执行、补建、完成；重复加入与拒绝情形 / enroll and progress', async () => {
    const c = (await newCadence({})).json;
    const l = await newLead({ ownerId: sales.user.id });
    const t0 = Date.now();
    const r = await enroll(c.id, [l.id, l.id]);
    expect(r.json).toEqual({ succeeded: [l.id], failed: [] });
    expect(await subjects(l.id)).toEqual(['首次电话']);
    const task = await prisma.activity.findFirstOrThrow({ where: { leadId: l.id } });
    expect(task).toMatchObject({ type: 'CALL', ownerId: sales.user.id });
    const e = await enrollmentOf(l.id);
    expect(e).toMatchObject({ status: 'ACTIVE', currentStep: 1, enrolledById: a.user.id });
    expect(Math.abs(e.nextDueAt!.getTime() - (e.enrolledAt.getTime() + 2 * DAY))).toBe(0);
    expect(e.enrolledAt.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    // 重复加入 / already enrolled
    expect((await enroll(c.id, [l.id])).json.failed[0]).toMatchObject({ id: l.id, code: 'CONFLICT' });
    // 未到期不处理；第 2 天执行一步；第 7 天补建两步并完成；再次运行无变化 / due processing, catch-up, completion
    expect((await sweepCadences({ now: later(1) })).processed).toBe(0);
    expect(await sweepCadences({ now: later(2) })).toMatchObject({ processed: 1, activities: 1 });
    expect(await subjects(l.id)).toEqual(['首次电话', '发目录']);
    expect(await sweepCadences({ now: later(8) })).toMatchObject({ processed: 1, activities: 2 });
    expect((await subjects(l.id)).sort()).toEqual(['发目录', '回访', '拜访', '首次电话'].sort());
    expect(await enrollmentOf(l.id)).toMatchObject({ status: 'COMPLETED', currentStep: 4, nextDueAt: null, endReason: 'completed' });
    expect((await sweepCadences({ now: later(9) })).processed).toBe(0);
    // 完成后可以再次加入 / can re-enroll after completion
    expect((await enroll(c.id, [l.id])).json.succeeded).toEqual([l.id]);
    // 列表与记录参与 / list counts and the record's enrollments
    expect((await call(cadences.GET, { token: a.token })).json.items[0].counts).toEqual({ active: 1, completed: 1, exited: 0, stopped: 0 });
    const list = (await call(enrollments.GET, { token: sales.token, query: { entity: 'LEAD', id: l.id } })).json.items;
    expect(list.map((x: { status: string; currentStep: number; cadence: { stepCount: number } }) => [x.status, x.currentStep, x.cadence.stepCount])).toEqual([['ACTIVE', 1, 4], ['COMPLETED', 4, 4]]);
    // 拒绝情形：已转化、退出状态、停用、他人记录、只读、超过 100 条 / refusals
    const conv = await newLead();
    await call(convert.POST, { token: a.token, params: { id: conv.id }, body: { account: { mode: 'new' } } });
    const qualified = await newLead({ status: 'QUALIFIED' });
    const others = await newLead({}, mgr.token);
    const res = await enroll(c.id, [conv.id, qualified.id, others.id], sales.token);
    expect(res.json.failed.map((f: { code: string }) => f.code)).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']); // 销售看不到他人记录 / invisible to sales
    const res2 = await enroll(c.id, [conv.id, qualified.id]);
    expect(res2.json.failed.map((f: { code: string }) => f.code)).toEqual(['CONFLICT', 'CONFLICT']);
    const ro = await addUser(a.org.id, 'READONLY', '只读');
    expect((await enroll(c.id, [qualified.id], ro.token)).status).toBe(403);
    expect((await enroll(c.id, Array.from({ length: 101 }, () => crypto.randomUUID()))).status).toBe(400);
    await patchCadence(c.id, { isActive: false });
    expect((await enroll(c.id, [others.id])).json.error.details).toEqual({ cadenceId: ['inactive'] });
    const b = await createTenant('B');
    expect((await enroll(c.id, [others.id], b.token)).status).toBe(404);
    expect((await call(enrollments.GET, { token: b.token, query: { entity: 'LEAD', id: l.id } })).status).toBe(404);
  });

  it('退出：状态变化、转化、商机阶段；停用暂停；停止；改步骤重算；负责人缺失给加入人；审计 / exits, pause, stop, edits', async () => {
    const c = (await newCadence({})).json;
    const [l1, l2, l3, l4] = [await newLead(), await newLead(), await newLead(), await newLead({ ownerId: sales.user.id })];
    await enroll(c.id, [l1.id, l2.id, l3.id, l4.id]);
    await prisma.lead.update({ where: { id: l1.id }, data: { status: 'QUALIFIED' } });
    await call(convert.POST, { token: a.token, params: { id: l2.id }, body: { account: { mode: 'new' } } });
    const r = await sweepCadences({ now: later(3) });
    expect(r).toMatchObject({ exited: 2, processed: 2, activities: 2 });
    expect(await enrollmentOf(l1.id)).toMatchObject({ status: 'EXITED', endReason: 'state:QUALIFIED', nextDueAt: null });
    expect(await enrollmentOf(l2.id)).toMatchObject({ status: 'EXITED', endReason: 'converted' });
    expect(await subjects(l1.id)).toEqual(['首次电话']); // 退出后不再创建 / nothing more after exit
    // 停用暂停，启用后补建 / inactive cadences pause and catch up when re-enabled
    await patchCadence(c.id, { isActive: false });
    expect((await sweepCadences({ now: later(6) })).processed).toBe(0);
    await patchCadence(c.id, { isActive: true });
    expect((await sweepCadences({ now: later(6) })).processed).toBe(2);
    // 停止：销售停止自己的；不能重复停止；他人 404 / stop
    const e4 = await enrollmentOf(l4.id);
    expect((await call(stop.POST, { token: sales.token, params: { id: e4.id } })).json).toEqual({ stopped: true });
    expect((await call(stop.POST, { token: sales.token, params: { id: e4.id } })).json.error.details).toEqual({ id: ['not_active'] });
    const e3 = await enrollmentOf(l3.id);
    expect((await call(stop.POST, { token: sales.token, params: { id: e3.id } })).status).toBe(404);
    expect((await sweepCadences({ now: later(30) })).processed).toBe(1);
    expect(await enrollmentOf(l4.id)).toMatchObject({ status: 'STOPPED', endReason: 'stopped' });
    expect(await enrollmentOf(l3.id)).toMatchObject({ status: 'COMPLETED' });
    // 改步骤：进行中的参与重算下一步时间；步骤减少到已执行之前则完成 / editing steps
    const l5 = await newLead();
    const l6 = await newLead();
    await enroll(c.id, [l5.id, l6.id]);
    await sweepCadences({ now: later(3) }); // 两条都执行到第 3 步之前 / both at step index 2
    await patchCadence(c.id, { entity: 'LEAD', steps: [STEPS[0], STEPS[1], { day: 20, type: 'MEETING', subject: '会议' }] });
    const e5 = await enrollmentOf(l5.id);
    expect(e5.currentStep).toBe(2);
    expect(e5.nextDueAt!.getTime()).toBe(e5.enrolledAt.getTime() + 20 * DAY);
    await patchCadence(c.id, { entity: 'LEAD', steps: [STEPS[0]] });
    expect(await enrollmentOf(l6.id)).toMatchObject({ status: 'COMPLETED', endReason: 'completed' });
    // 负责人缺失或停用时给加入人 / tasks go to the enroller without an active owner
    const d = (await newCadence({ name: '商机节奏', entity: 'DEAL', steps: [{ day: 0, type: 'TASK', subject: '确认方案' }, { day: 3, type: 'CALL', subject: '答疑' }], exitStates: ['CLOSED_WON'] })).json;
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, ownerId: sales.user.id } })).json;
    await prisma.user.update({ where: { id: sales.user.id }, data: { isActive: false } });
    await enroll(d.id, [deal.id], mgr.token);
    expect((await prisma.activity.findFirstOrThrow({ where: { dealId: deal.id } })).ownerId).toBe(mgr.user.id);
    await prisma.deal.update({ where: { id: deal.id }, data: { stage: 'CLOSED_WON' } });
    await sweepCadences({ now: later(4) });
    expect(await prisma.cadenceEnrollment.findFirstOrThrow({ where: { dealId: deal.id } })).toMatchObject({ status: 'EXITED', endReason: 'state:CLOSED_WON' });
    expect(await prisma.activity.count({ where: { dealId: deal.id } })).toBe(1);
    // 审计：跟进由节奏创建（系统执行时没有操作人）/ audits
    const acts = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'activity', action: 'activity.create' } })).json.items as { actorId: string | null; changes: { cadence?: string; step?: number; of?: number } }[];
    expect(acts.filter((x) => x.changes.cadence === '节奏' && x.actorId === null).length).toBeGreaterThan(0);
    expect(acts.find((x) => x.changes.cadence === '商机节奏')).toMatchObject({ actorId: mgr.user.id, changes: { step: 1, of: 2 } });
    const stops = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'cadence', action: 'cadence.stop' } })).json.items;
    expect(stops).toHaveLength(1);
  });
});
