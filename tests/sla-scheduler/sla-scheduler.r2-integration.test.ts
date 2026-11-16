/**
 * SLA 定时任务 第二轮：集成测试（定时任务与页面按需检查、多个定时任务同时运行时每张工单只升级一次；
 * 一个组织出错不影响其他组织并报告失败；按传入时刻判断超时；组织停用 SLA 后不再处理；不改动未超时与已解决的工单）。
 * SLA scheduler round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as unread from '@/app/api/notifications/unread-count/route';
import * as tickets from '@/app/api/tickets/route';
import * as sla from '@/app/api/tickets/sla/route';
import { prisma } from '@/server/db';
import { sweepAllEscalations, sweepEscalations } from '@/server/modules/ticket-sla';
import { addUser, call, createTenant, resetDb } from '../helpers';

const H = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
const policy = (extra: object = {}) => ({ enabled: true, urgentHours: 4, highHours: 24, mediumHours: 72, lowHours: 168, escalateToId: null, ...extra });

/** 启用 SLA 的组织与若干工单 / an organization with an SLA and tickets */
async function tenant(label: string, dues: (number | null)[], extra: object = {}) {
  const t = await createTenant(label);
  await call(sla.PUT, { token: t.token, body: policy(extra), method: 'PUT' });
  const acc = (await call(accounts.POST, { token: t.token, body: { name: `${label}客户` } })).json;
  const ids: string[] = [];
  for (const [i, h] of dues.entries()) ids.push((await call(tickets.POST, { token: t.token, body: { subject: `${label}${i}`, accountId: acc.id, dueAt: h === null ? null : at(h) } })).json.id);
  return { ...t, ids };
}

beforeEach(async () => {
  await resetDb();
});

describe('SLA scheduler R2', () => {
  it('定时任务与按需检查同时运行：只升级、只通知一次 / scheduler vs on-demand', async () => {
    const a = await tenant('A', [-1, -2, -3]);
    const mgr = await addUser(a.org.id, 'MANAGER', '主管');
    await call(sla.PUT, { token: a.token, body: policy({ escalateToId: mgr.user.id }), method: 'PUT' });
    await Promise.all([
      sweepAllEscalations(),
      sweepAllEscalations(),
      sweepEscalations(a.org.id),
      call(unread.GET, { token: a.token }),
      call(unread.GET, { token: mgr.token }),
      call(tickets.GET, { token: a.token }),
    ]);
    expect(await prisma.ticket.count({ where: { escalatedAt: { not: null } } })).toBe(3);
    expect(await prisma.notification.count({ where: { type: 'TICKET_ESCALATED', userId: a.user.id } })).toBe(3);
    expect(await prisma.notification.count({ where: { type: 'TICKET_ESCALATED', userId: mgr.user.id } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'ticket.escalate' } })).toBe(3);
  });

  it('一个组织出错不影响其他组织，并报告失败 / failure isolation', async () => {
    const a = await tenant('A', [-1]);
    const b = await tenant('B', [-1, -2]);
    const r = await sweepAllEscalations(new Date(), async (orgId, now) => {
      if (orgId === a.org.id) throw new Error('模拟故障 simulated failure');
      return sweepEscalations(orgId, now);
    });
    expect(r.organizations).toBe(2);
    expect(r.escalated).toBe(2);
    expect(r.failures).toEqual([{ organizationId: a.org.id, error: '模拟故障 simulated failure' }]);
    expect(await prisma.ticket.count({ where: { organizationId: b.org.id, escalatedAt: { not: null } } })).toBe(2);
    expect(await prisma.ticket.count({ where: { organizationId: a.org.id, escalatedAt: { not: null } } })).toBe(0);
    // 下一次运行补上 / the next run catches up
    expect((await sweepAllEscalations()).escalated).toBe(1);
  });

  it('按传入时刻判断；不改动未超时、无期限、已解决的工单；停用后不处理 / time, untouched tickets, disabled', async () => {
    const a = await tenant('A', [2, 10, null]);
    await call(tickets.POST, { token: a.token, body: { subject: '已解决', accountId: (await prisma.account.findFirstOrThrow({ where: { organizationId: a.org.id } })).id, dueAt: at(-5), status: 'RESOLVED', resolution: '完成' } });
    // 现在：无超时 / now: nothing overdue
    expect((await sweepAllEscalations()).escalated).toBe(0);
    // 3 小时后：2 小时到期的那张超时 / three hours later the 2-hour ticket is overdue
    expect((await sweepAllEscalations(new Date(Date.now() + 3 * H))).escalated).toBe(1);
    const escalated = await prisma.ticket.findMany({ where: { escalatedAt: { not: null } }, select: { id: true } });
    expect(escalated.map((t) => t.id)).toEqual([a.ids[0]]);
    // 停用后，即使更晚也不处理 / disabled: nothing even later
    await call(sla.PUT, { token: a.token, body: policy({ enabled: false }), method: 'PUT' });
    expect(await sweepAllEscalations(new Date(Date.now() + 20 * H))).toEqual({ organizations: 0, escalated: 0, failures: [] });
    expect(await prisma.ticket.count({ where: { escalatedAt: { not: null } } })).toBe(1);
  });
});
