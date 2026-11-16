/**
 * 工单 SLA 超时升级 第二轮：集成测试（销售、只读可查看规则不能修改，经理可修改；升级接收人不能是其他组织或已停用的用户；
 * 规则与升级按组织隔离；客户端不能提交 dueAuto、escalatedAt；并发检查每张工单只升级、只通知一次；未登录；跨域预检）。
 * Ticket SLA escalation round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as unread from '@/app/api/notifications/unread-count/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import * as sla from '@/app/api/tickets/sla/route';
import { prisma } from '@/server/db';
import { sweepEscalations } from '@/server/modules/ticket-sla';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let viewer: Who;
let acc: { id: string };
const body = (extra: object = {}) => ({ enabled: true, urgentHours: 4, highHours: 24, mediumHours: 72, lowHours: 168, escalateToId: null, ...extra });
const put = (who: Who, extra: object = {}) => call(sla.PUT, { token: who.token, body: body(extra), method: 'PUT' });
const past = () => new Date(Date.now() - 3_600_000).toISOString();

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
  acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户', ownerId: sales1.user.id } })).json;
});

describe('ticket SLA R2 permissions & isolation', () => {
  it('销售、只读可查看不能修改；经理可修改 / who may change the policy', async () => {
    for (const who of [sales1, viewer]) {
      expect((await call(sla.GET, { token: who.token })).status).toBe(200);
      const r = await put(who);
      expect(r.status).toBe(403);
      expect(r.json.error.details).toEqual({ permission: ['sla.manage'] });
    }
    expect(await prisma.ticketSlaPolicy.count()).toBe(0);
    expect((await put(manager, { escalateToId: sales1.user.id })).status).toBe(200);
    expect((await call(sla.GET, { token: sales1.token })).json).toMatchObject({ enabled: true, escalateTo: { id: sales1.user.id } });
  });

  it('接收人不能是其他组织或已停用的用户；规则与升级按组织隔离 / recipients and isolation', async () => {
    expect((await put(admin, { escalateToId: other.user.id })).json.error.details).toEqual({ escalateToId: ['not_found'] });
    await prisma.user.update({ where: { id: viewer.user.id }, data: { isActive: false } });
    expect((await put(admin, { escalateToId: viewer.user.id })).json.error.details).toEqual({ escalateToId: ['not_found'] });
    await put(admin);
    // 其他组织未启用：其超时工单不升级，规则显示为未配置 / the other org has no policy
    expect((await call(sla.GET, { token: other.token })).json.configured).toBe(false);
    const oAcc = (await call(accounts.POST, { token: other.token, body: { name: '乙方' } })).json;
    const oTk = (await call(tickets.POST, { token: other.token, body: { subject: '乙方工单', accountId: oAcc.id, dueAt: past() } })).json;
    await call(tickets.POST, { token: admin.token, body: { subject: '甲方工单', accountId: acc.id, dueAt: past() } });
    expect(await sweepEscalations(other.org.id)).toBe(0);
    expect(await sweepEscalations(admin.org.id)).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: oTk.id } })).escalatedAt).toBeNull();
    // 其他组织的新工单不按本组织规则自动计算期限 / the other org's tickets get no automatic due time
    expect((await call(tickets.POST, { token: other.token, body: { subject: '无期限', accountId: oAcc.id } })).json.dueAuto).toBe(false);
  });

  it('客户端不能提交 dueAuto、escalatedAt；未登录 / server-owned fields and auth', async () => {
    for (const extra of [{ dueAuto: true }, { escalatedAt: new Date().toISOString() }]) {
      expect((await call(tickets.POST, { token: admin.token, body: { subject: 'x', accountId: acc.id, ...extra } })).status).toBe(400);
    }
    const tk = (await call(tickets.POST, { token: admin.token, body: { subject: 'x', accountId: acc.id } })).json;
    expect((await call(ticketItem.PATCH, { token: admin.token, params: { id: tk.id }, body: { escalatedAt: null }, method: 'PATCH' })).status).toBe(400);
    expect((await call(sla.GET)).status).toBe(401);
    expect((await call(sla.PUT, { body: body(), method: 'PUT' })).status).toBe(401);
  });
});

describe('ticket SLA R2 concurrency & cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('多人同时触发检查：每张工单只升级、只通知一次 / concurrent sweeps', async () => {
    await put(admin, { escalateToId: manager.user.id });
    for (let i = 0; i < 5; i++) await call(tickets.POST, { token: admin.token, body: { subject: `超时${i}`, accountId: acc.id, ownerId: sales1.user.id, dueAt: past() } });
    const results = await Promise.all([
      ...[admin, manager, sales1, viewer].map((who) => call(unread.GET, { token: who.token })),
      ...Array.from({ length: 4 }, () => call(tickets.GET, { token: admin.token })),
      sweepEscalations(admin.org.id),
    ]);
    expect(results.length).toBe(9);
    expect(await prisma.ticket.count({ where: { escalatedAt: { not: null } } })).toBe(5);
    // 负责人与接收人各 5 条 / five each for the owner and the recipient
    expect(await prisma.notification.count({ where: { type: 'TICKET_ESCALATED', userId: sales1.user.id } })).toBe(5);
    expect(await prisma.notification.count({ where: { type: 'TICKET_ESCALATED', userId: manager.user.id } })).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: 'ticket.escalate' } })).toBe(5);
    // 销售看到自己工单的升级 / the rep sees their escalated tickets
    expect((await call(tickets.GET, { token: sales1.token, query: { escalated: 'true' } })).json.total).toBe(5);
  });

  it('跨域预检 / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await sla.OPTIONS(new Request('http://localhost/api/tickets/sla', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});
