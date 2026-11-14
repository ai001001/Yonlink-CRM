/**
 * 站内通知与提醒 第一轮：功能测试（分配通知、到期提醒的生成与撤销、列表与未读数、已读、删除、清除已读、保留期、演示数据）。
 * Notifications round 1: functional tests (assignment notices, reminder generation and withdrawal, list and unread
 * count, mark read, delete, clear read, retention, demo data).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME, demoNotifications } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as activity from '@/app/api/activities/[id]/route';
import * as activities from '@/app/api/activities/route';
import * as deals from '@/app/api/deals/route';
import * as leadBulk from '@/app/api/leads/bulk/route';
import * as lead from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as clearRead from '@/app/api/notifications/clear-read/route';
import * as one from '@/app/api/notifications/[id]/route';
import * as read from '@/app/api/notifications/read/route';
import * as notifications from '@/app/api/notifications/route';
import * as unread from '@/app/api/notifications/unread-count/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let s: Awaited<ReturnType<typeof addUser>>;
const post = async (route: { POST: Parameters<typeof call>[0] }, body: object, token = a.token) => (await call(route.POST, { token, body })).json;
const patch = async (route: { PATCH: Parameters<typeof call>[0] }, id: string, body: object, token = a.token) =>
  call(route.PATCH, { token, body, params: { id }, method: 'PATCH' });
const list = async (token: string, query: Record<string, string> = {}) => (await call(notifications.GET, { token, query })).json;
const count = async (token: string) => (await call(unread.GET, { token })).json.count as number;
const inMin = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  s = await addUser(a.org.id, 'SALES', 'Sales');
});

describe('notifications R1 assignment', () => {
  it('新建时分配给他人会通知负责人，分配给自己不通知 / create assigned to someone else notifies', async () => {
    const l = await post(leads, { name: '张三', ownerId: s.user.id });
    await post(leads, { name: '李四' });
    const r = await list(s.token);
    expect(r.total).toBe(1);
    expect(r.unread).toBe(1);
    expect(r.items[0]).toMatchObject({ type: 'ASSIGNED', title: '张三', leadId: l.id, readAt: null, actor: { id: a.user.id } });
    expect((await list(a.token)).total).toBe(0);
  });

  it('修改负责人才通知；负责人不变或改回自己不通知 / only an owner change notifies', async () => {
    const l = await post(leads, { name: '张三' });
    expect((await patch(lead, l.id, { ownerId: s.user.id })).status).toBe(200);
    expect((await patch(lead, l.id, { company: '甲公司', ownerId: s.user.id })).status).toBe(200);
    expect((await patch(lead, l.id, { ownerId: a.user.id })).status).toBe(200);
    expect(await count(s.token)).toBe(1);
    expect(await count(a.token)).toBe(0);
  });

  it('客户、商机、跟进分配都会通知并关联对应记录 / accounts, deals and activities notify too', async () => {
    const acc = await post(accounts, { name: '甲公司', ownerId: s.user.id });
    const deal = await post(deals, { name: '大单', accountId: acc.id, amount: '100', ownerId: s.user.id });
    const act = await post(activities, { type: 'CALL', subject: '回访', ownerId: s.user.id });
    const r = await list(s.token);
    expect(r.items.map((n: { title: string }) => n.title).sort()).toEqual(['回访', '大单', '甲公司'].sort());
    expect(r.items.find((n: { title: string }) => n.title === '甲公司').accountId).toBe(acc.id);
    expect(r.items.find((n: { title: string }) => n.title === '大单').dealId).toBe(deal.id);
    expect(r.items.find((n: { title: string }) => n.title === '回访').activityId).toBe(act.id);
  });

  it('批量分配每条记录各通知一次 / bulk assignment notifies per record', async () => {
    const ids = [(await post(leads, { name: 'L1' })).id, (await post(leads, { name: 'L2' })).id];
    expect((await call(leadBulk.POST, { token: a.token, body: { action: 'assign', ids, ownerId: s.user.id } })).status).toBe(200);
    expect(await count(s.token)).toBe(2);
  });
});

describe('notifications R1 reminders', () => {
  it('到期前 30 分钟内、逾期 24 小时内生成提醒，重复读取不重复生成 / reminder window and idempotency', async () => {
    const mk = (subject: string, dueAt: string | null, completed = false) => post(activities, { type: 'TASK', subject, dueAt, completed }, s.token);
    await mk('十分钟后', inMin(10));
    await mk('两小时后', inMin(120));
    await mk('两小时前', inMin(-120));
    await mk('两天前', inMin(-48 * 60));
    await mk('已完成', inMin(5), true);
    await mk('无截止', null);
    expect(await count(s.token)).toBe(2);
    expect(await count(s.token)).toBe(2);
    const r = await list(s.token);
    expect(r.items.map((n: { title: string }) => n.title).sort()).toEqual(['两小时前', '十分钟后'].sort());
    expect(r.items.every((n: { type: string; dueAt: string }) => n.type === 'ACTIVITY_DUE' && n.dueAt)).toBe(true);
  });

  it('改期撤销未读旧提醒，新时间在窗口内会重新提醒；完成后撤销 / reschedule and completion withdraw', async () => {
    const act = await post(activities, { type: 'CALL', subject: '回访', dueAt: inMin(10) }, s.token);
    expect(await count(s.token)).toBe(1);
    const later = inMin(20);
    await patch(activity, act.id, { dueAt: later }, s.token);
    expect(await prisma.notification.count({ where: { activityId: act.id } })).toBe(0);
    expect(await count(s.token)).toBe(1);
    const r = await list(s.token);
    expect(new Date(r.items[0].dueAt).getTime()).toBe(new Date(later).getTime());
    await patch(activity, act.id, { completed: true }, s.token);
    expect(await count(s.token)).toBe(0);
  });

  it('已读的提醒不随改期删除 / read reminders survive rescheduling', async () => {
    const act = await post(activities, { type: 'CALL', subject: '回访', dueAt: inMin(10) }, s.token);
    await count(s.token);
    await call(read.POST, { token: s.token, body: { all: true } });
    await patch(activity, act.id, { dueAt: inMin(300) }, s.token);
    expect((await list(s.token)).total).toBe(1);
  });
});

describe('notifications R1 inbox', () => {
  it('列表最新在前、未读筛选、分页 / newest first, unread filter, paging', async () => {
    for (const name of ['L1', 'L2', 'L3']) await post(leads, { name, ownerId: s.user.id });
    const first = (await list(s.token)).items[2];
    await call(read.POST, { token: s.token, body: { ids: [first.id] } });
    const all = await list(s.token);
    expect(all.items.map((n: { title: string }) => n.title)).toEqual(['L3', 'L2', 'L1']);
    expect(all.unread).toBe(2);
    expect(all.items[2].readAt).not.toBeNull();
    const un = await list(s.token, { status: 'unread' });
    expect(un.total).toBe(2);
    const p2 = await list(s.token, { pageSize: '2', page: '2' });
    expect(p2.items.map((n: { title: string }) => n.title)).toEqual(['L1']);
  });

  it('全部已读、删除单条、清除已读 / mark all read, delete, clear read', async () => {
    for (const name of ['L1', 'L2', 'L3']) await post(leads, { name, ownerId: s.user.id });
    const items = (await list(s.token)).items;
    expect((await call(read.POST, { token: s.token, body: { ids: [items[0].id] } })).json).toEqual({ updated: 1 });
    expect((await call(read.POST, { token: s.token, body: { ids: [items[0].id] } })).json).toEqual({ updated: 0 });
    expect((await call(one.DELETE, { token: s.token, params: { id: items[1].id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(clearRead.POST, { token: s.token })).json).toEqual({ deleted: 1 });
    expect((await list(s.token)).items.map((n: { title: string }) => n.title)).toEqual(['L1']);
    expect((await call(read.POST, { token: s.token, body: { all: true } })).json).toEqual({ updated: 1 });
    expect(await count(s.token)).toBe(0);
  });

  it('记录删除后通知随之删除；超过 90 天的通知被清理 / removed with the record; pruned after 90 days', async () => {
    const l = await post(leads, { name: 'L1', ownerId: s.user.id });
    await post(leads, { name: 'L2', ownerId: s.user.id });
    expect((await call(lead.DELETE, { token: a.token, params: { id: l.id }, method: 'DELETE' })).status).toBe(204);
    expect((await list(s.token)).items.map((n: { title: string }) => n.title)).toEqual(['L2']);
    await prisma.notification.updateMany({ where: { userId: s.user.id }, data: { createdAt: new Date(Date.now() - 91 * 86400_000) } });
    expect(await count(s.token)).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe('notifications R1 demo', () => {
  it('演示数据：通知属于接收人负责的记录，未读/已读与定义一致 / demo notifications', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const expected = demoNotifications(buildDemoData());
    const rows = await prisma.notification.findMany({
      where: { organizationId: org.id },
      include: { user: true, lead: true, account: true, deal: true },
    });
    expect(rows).toHaveLength(expected.length);
    expect(rows.filter((r) => r.readAt === null)).toHaveLength(expected.filter((n) => !n.read).length);
    for (const r of rows) {
      const record = r.lead ?? r.account ?? r.deal;
      expect(record?.ownerId).toBe(r.userId);
      expect(r.actorId).not.toBe(r.userId);
      expect(r.title).toBe(record?.name);
    }
  });
});
