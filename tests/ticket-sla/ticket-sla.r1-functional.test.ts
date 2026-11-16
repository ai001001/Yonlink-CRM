/**
 * 工单 SLA 超时升级 第一轮：功能测试（未配置时的默认值、保存与审计；启用后新建按优先级自动计算期限、手动期限保留、
 * 改优先级重算自动期限；超时升级只发生一次、通知负责人与升级接收人（同一人只通知一次）、系统审计；已解决不升级；
 * 期限移到未来清除升级、再次超时可再升级；停用不升级；“只看已升级”筛选；工作台卡片；演示数据）。
 * Ticket SLA escalation round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as unread from '@/app/api/notifications/unread-count/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import * as sla from '@/app/api/tickets/sla/route';
import { prisma } from '@/server/db';
import { sweepEscalations } from '@/server/modules/ticket-sla';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
const H = 3_600_000;
const hours = (h: number) => new Date(Date.now() + h * H).toISOString();
const create = (body: object, token = a.token) => call(tickets.POST, { token, body: { subject: '工单', accountId: acc.id, ...body } });
const patch = (id: string, body: object) => call(ticketItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });
const saveSla = (body: object, token = a.token) =>
  call(sla.PUT, { token, body: { enabled: true, urgentHours: 4, highHours: 24, mediumHours: 72, lowHours: 168, escalateToId: null, ...body }, method: 'PUT' });
const near = (iso: string, expectedMs: number) => expect(Math.abs(new Date(iso).getTime() - expectedMs)).toBeLessThan(60_000);

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
});

describe('ticket SLA R1 policy', () => {
  it('未配置时返回默认值；保存、校验与审计 / defaults, save, audit', async () => {
    expect((await call(sla.GET, { token: a.token })).json).toEqual({ configured: false, enabled: false, urgentHours: 4, highHours: 24, mediumHours: 72, lowHours: 168, escalateToId: null, escalateTo: null });
    const mgr = await addUser(a.org.id, 'MANAGER', '主管');
    const r = await saveSla({ urgentHours: 2, escalateToId: mgr.user.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ configured: true, enabled: true, urgentHours: 2, escalateTo: { id: mgr.user.id } });
    for (const body of [{ urgentHours: 0 }, { lowHours: 8761 }, { highHours: 1.5 }, { escalateToId: 'x' }, { extra: 1 }]) expect((await saveSla(body)).status).toBe(400);
    expect((await saveSla({ escalateToId: '00000000-0000-4000-8000-000000000000' })).json.error.details).toEqual({ escalateToId: ['not_found'] });
    await saveSla({ urgentHours: 2, escalateToId: mgr.user.id, enabled: false });
    const logs = await prisma.auditLog.findMany({ where: { action: 'sla.update' }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[0]!.changes).toMatchObject({ fields: { enabled: [null, true], urgentHours: [null, 2], escalateToId: [null, mgr.user.id] } });
    expect(logs[1]!.changes).toEqual({ fields: { enabled: [true, false] } });
  });

  it('启用后自动计算期限；手动期限保留；改优先级重算 / automatic due times', async () => {
    // 未启用：不自动 / disabled: nothing automatic
    expect((await create({})).json).toMatchObject({ dueAt: null, dueAuto: false });
    await saveSla({});
    const t0 = Date.now();
    const auto = (await create({ priority: 'URGENT' })).json;
    expect(auto.dueAuto).toBe(true);
    near(auto.dueAt, t0 + 4 * H);
    const manual = (await create({ priority: 'URGENT', dueAt: hours(100) })).json;
    expect(manual.dueAuto).toBe(false);
    expect((await create({ dueAt: null })).json).toMatchObject({ dueAt: null, dueAuto: false });
    // 改优先级：自动期限按创建时间重算，手动期限不变 / priority change: automatic due recomputed from creation
    const up = (await patch(auto.id, { priority: 'LOW' })).json;
    near(up.dueAt, new Date(auto.createdAt).getTime() + 168 * H);
    expect(up.dueAuto).toBe(true);
    expect((await patch(manual.id, { priority: 'LOW' })).json.dueAt).toBe(manual.dueAt);
    // 手动改期限后不再自动 / a hand-set due time stops being automatic
    const fixed = (await patch(auto.id, { dueAt: hours(10) })).json;
    expect(fixed.dueAuto).toBe(false);
    expect((await patch(auto.id, { priority: 'URGENT' })).json.dueAt).toBe(fixed.dueAt);
  });
});

describe('ticket SLA R1 escalation', () => {
  it('超时升级一次，通知负责人与接收人，写系统审计；已解决不升级 / escalate once', async () => {
    const mgr = await addUser(a.org.id, 'MANAGER', '主管');
    await saveSla({ escalateToId: mgr.user.id });
    const late = (await create({ subject: '超时', dueAt: hours(-1) })).json;
    await create({ subject: '已解决', dueAt: hours(-1), status: 'RESOLVED', resolution: '完成' });
    await create({ subject: '未到期', dueAt: hours(5) });
    const list = (await call(tickets.GET, { token: a.token })).json;
    const row = list.items.find((x: { id: string }) => x.id === late.id);
    expect(row.escalatedAt).not.toBeNull();
    expect(list.items.filter((x: { escalatedAt: string | null }) => x.escalatedAt)).toHaveLength(1);
    // 再次检查不重复 / a second check does nothing
    expect(await sweepEscalations(a.org.id)).toBe(0);
    const notes = await prisma.notification.findMany({ where: { type: 'TICKET_ESCALATED' } });
    expect(notes.map((n) => n.userId).sort()).toEqual([a.user.id, mgr.user.id].sort());
    expect(notes.every((n) => n.ticketId === late.id && n.title === `${late.ticketNumber} 超时` && n.actorId === null)).toBe(true);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.escalate' } });
    expect(log).toMatchObject({ actorId: null, entityId: late.id, changes: { dueAt: late.dueAt, notified: 2 } });
    // 未读数接口也会触发检查 / the unread-count endpoint also runs the check
    expect((await call(unread.GET, { token: mgr.token })).json.count).toBe(1);
  });

  it('负责人即接收人时只通知一次；没有接收人只通知负责人 / dedupe recipients', async () => {
    await saveSla({ escalateToId: a.user.id });
    await create({ dueAt: hours(-1) });
    expect(await sweepEscalations(a.org.id)).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'TICKET_ESCALATED' } })).toBe(1);
    await saveSla({ escalateToId: null });
    const agent = await addUser(a.org.id, 'SALES', '客服');
    await create({ dueAt: hours(-2), ownerId: agent.user.id });
    expect(await sweepEscalations(a.org.id)).toBe(1);
    expect((await prisma.notification.findMany({ where: { type: 'TICKET_ESCALATED' }, orderBy: { createdAt: 'asc' } })).map((n) => n.userId)).toEqual([a.user.id, agent.user.id]);
  });

  it('期限移到未来清除升级、再次超时可再升级；停用不升级；筛选 / reset, re-escalate, disabled, filter', async () => {
    await saveSla({});
    const tk = (await create({ dueAt: hours(-1) })).json;
    await sweepEscalations(a.org.id);
    expect((await call(tickets.GET, { token: a.token, query: { escalated: 'true' } })).json.total).toBe(1);
    const moved = (await patch(tk.id, { dueAt: hours(3) })).json;
    expect(moved.escalatedAt).toBeNull();
    expect((await call(tickets.GET, { token: a.token, query: { escalated: 'true' } })).json.total).toBe(0);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.update', entityId: tk.id } })).changes).toMatchObject({ fields: { escalatedAt: [expect.any(String), null] } });
    // 再次超时可再次升级 / passing the new due time escalates again
    await prisma.ticket.update({ where: { id: tk.id }, data: { dueAt: new Date(Date.now() - H) } });
    expect(await sweepEscalations(a.org.id)).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'TICKET_ESCALATED' } })).toBe(2);
    // 已升级工单解决后不再出现在筛选中 / resolved escalated tickets leave the filter
    await patch(tk.id, { status: 'RESOLVED', resolution: '完成' });
    expect((await call(tickets.GET, { token: a.token, query: { escalated: 'true' } })).json.total).toBe(0);
    // 停用后不升级 / disabled: no escalation
    await saveSla({ enabled: false });
    await create({ dueAt: hours(-1) });
    expect(await sweepEscalations(a.org.id)).toBe(0);
    expect((await call(tickets.GET, { token: a.token, query: { escalated: 'yes' } })).status).toBe(400);
  });

  it('工作台卡片显示升级；演示 SLA / dashboard card and demo', async () => {
    await saveSla({});
    await create({ subject: '卡片', dueAt: hours(-1) });
    const card = (await call(dashboard.GET, { token: a.token })).json.myTickets;
    expect(card.items[0].escalatedAt).not.toBeNull();
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const policy = await prisma.ticketSlaPolicy.findUniqueOrThrow({ where: { organizationId: org.id }, include: { escalateTo: true } });
    expect(policy).toMatchObject({ enabled: true, urgentHours: 4, escalateTo: { role: 'MANAGER' } });
    expect(await sweepEscalations(org.id)).toBeGreaterThan(0);
  });
});
