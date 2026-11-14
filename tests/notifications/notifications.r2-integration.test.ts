/**
 * 站内通知与提醒 第二轮：集成测试（租户与用户隔离、参数校验、未登录、并发生成提醒、跟进改负责人、
 * 与回收站/查重合并/线索转化/导入/批量完成的配合、审计、跨域预检）。
 * Notifications round 2: integration tests (tenant and user isolation, validation, unauthenticated access,
 * concurrent reminder generation, activity reassignment, interplay with the recycle bin, merge, conversion,
 * import and bulk completion, audit, CORS preflight).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as activityBulk from '@/app/api/activities/bulk/route';
import * as activity from '@/app/api/activities/[id]/route';
import * as activities from '@/app/api/activities/route';
import * as merge from '@/app/api/duplicates/merge/route';
import * as leadConvert from '@/app/api/leads/[id]/convert/route';
import * as lead from '@/app/api/leads/[id]/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leads from '@/app/api/leads/route';
import * as clearRead from '@/app/api/notifications/clear-read/route';
import * as one from '@/app/api/notifications/[id]/route';
import * as read from '@/app/api/notifications/read/route';
import * as notifications from '@/app/api/notifications/route';
import * as unread from '@/app/api/notifications/unread-count/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
let s: Awaited<ReturnType<typeof addUser>>;
let s2: Awaited<ReturnType<typeof addUser>>;
const post = async (route: { POST: Parameters<typeof call>[0] }, body: object, token = a.token, params?: Record<string, string>) =>
  (await call(route.POST, { token, body, params })).json;
const list = async (token: string) => (await call(notifications.GET, { token })).json;
const count = async (token: string) => (await call(unread.GET, { token })).json.count as number;
const inMin = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
  s = await addUser(a.org.id, 'SALES', 'Sales');
  s2 = await addUser(a.org.id, 'SALES', 'Sales2');
});

describe('notifications R2 isolation & validation', () => {
  it('其他用户（同组织或跨组织）看不到、改不了、删不掉我的通知 / other users cannot touch my notifications', async () => {
    await post(leads, { name: 'L1', ownerId: s.user.id });
    const [n] = (await list(s.token)).items;
    for (const token of [s2.token, a.token, b.token]) {
      expect((await list(token)).total).toBe(0);
      expect((await call(read.POST, { token, body: { ids: [n.id] } })).json).toEqual({ updated: 0 });
      expect((await call(read.POST, { token, body: { all: true } })).json).toEqual({ updated: 0 });
      expect((await call(one.DELETE, { token, params: { id: n.id }, method: 'DELETE' })).status).toBe(404);
      expect((await call(clearRead.POST, { token })).json).toEqual({ deleted: 0 });
    }
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.readAt).toBeNull();
  });

  it('跨组织不能把记录分配给别的组织的用户，因而不会产生通知 / no cross-tenant assignment', async () => {
    const r = await call(leads.POST, { token: a.token, body: { name: 'X', ownerId: b.user.id } });
    expect(r.status).toBe(400);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('参数校验 / validation', async () => {
    const bad = [{}, { ids: [] }, { ids: ['x'] }, { all: false }, { ids: [crypto.randomUUID()], all: true }, { ids: Array.from({ length: 101 }, () => crypto.randomUUID()) }];
    for (const body of bad) expect((await call(read.POST, { token: s.token, body })).status).toBe(400);
    for (const query of [{ pageSize: '51' }, { status: 'read' }, { page: '0' }, { foo: '1' }] as Record<string, string>[]) {
      expect((await call(notifications.GET, { token: s.token, query })).status).toBe(400);
    }
    expect((await call(one.DELETE, { token: s.token, params: { id: 'abc' }, method: 'DELETE' })).status).toBe(404);
  });

  it('未登录 401；只读角色也能查看自己的通知 / 401 without a session; read-only users have an inbox too', async () => {
    expect((await call(notifications.GET)).status).toBe(401);
    expect((await call(unread.GET)).status).toBe(401);
    expect((await call(read.POST, { body: { all: true } })).status).toBe(401);
    const ro = await addUser(a.org.id, 'READONLY', 'Viewer');
    expect((await call(notifications.GET, { token: ro.token })).status).toBe(200);
    expect(await count(ro.token)).toBe(0);
  });
});

describe('notifications R2 reminders', () => {
  it('并发读取未读数只生成一条提醒 / concurrent syncs create one reminder', async () => {
    await post(activities, { type: 'CALL', subject: '回访', dueAt: inMin(5) }, s.token);
    const counts = await Promise.all(Array.from({ length: 6 }, () => count(s.token)));
    expect(counts.every((c) => c === 1)).toBe(true);
    expect(await prisma.notification.count({ where: { type: 'ACTIVITY_DUE' } })).toBe(1);
  });

  it('只提醒自己负责的跟进 / only my own activities remind me', async () => {
    await post(activities, { type: 'CALL', subject: '别人的', dueAt: inMin(5) }, s2.token);
    expect(await count(s.token)).toBe(0);
    expect(await count(s2.token)).toBe(1);
  });

  it('跟进改负责人：撤销原负责人的未读提醒，新负责人收到分配通知和提醒 / reassignment moves the reminder', async () => {
    const act = await post(activities, { type: 'CALL', subject: '回访', dueAt: inMin(5), ownerId: s.user.id });
    expect(await count(s.token)).toBe(2); // 分配 + 提醒 / assignment + reminder
    expect((await call(activity.PATCH, { token: a.token, body: { ownerId: s2.user.id }, params: { id: act.id }, method: 'PATCH' })).status).toBe(200);
    const mine = await list(s.token);
    expect(mine.items.map((n: { type: string }) => n.type)).toEqual(['ASSIGNED']);
    const theirs = await list(s2.token);
    expect(theirs.items.map((n: { type: string }) => n.type).sort()).toEqual(['ACTIVITY_DUE', 'ASSIGNED']);
  });

  it('批量完成撤销提醒；删除跟进时提醒随之删除 / bulk completion withdraws; deletion cascades', async () => {
    const a1 = await post(activities, { type: 'CALL', subject: 'A1', dueAt: inMin(5) }, s.token);
    const a2 = await post(activities, { type: 'CALL', subject: 'A2', dueAt: inMin(6) }, s.token);
    expect(await count(s.token)).toBe(2);
    expect((await call(activityBulk.POST, { token: s.token, body: { action: 'complete', ids: [a1.id], completed: true } })).status).toBe(200);
    expect(await count(s.token)).toBe(1);
    expect((await call(activity.DELETE, { token: a.token, params: { id: a2.id }, method: 'DELETE' })).status).toBe(204);
    expect(await count(s.token)).toBe(0);
  });
});

describe('notifications R2 interplay', () => {
  it('删除进回收站后通知删除，恢复记录不恢复通知 / recycle removes, restore does not bring back', async () => {
    const l = await post(leads, { name: 'L1', ownerId: s.user.id });
    await call(lead.DELETE, { token: a.token, params: { id: l.id }, method: 'DELETE' });
    expect(await count(s.token)).toBe(0);
    const item = await prisma.recycleBinItem.findFirstOrThrow({ where: { entityId: l.id } });
    expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    expect(await count(s.token)).toBe(0);
  });

  it('查重合并：被合并记录的通知删除；选用另一位负责人时通知新负责人 / merge', async () => {
    const master = await post(accounts, { name: '甲公司' });
    const dup = await post(accounts, { name: '甲 公司', ownerId: s.user.id });
    expect(await count(s.token)).toBe(1);
    const r = await call(merge.POST, { token: a.token, body: { entity: 'accounts', masterId: master.id, duplicateIds: [dup.id], fields: { ownerId: dup.id } } });
    expect(r.status).toBe(200);
    const items = (await list(s.token)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'ASSIGNED', accountId: master.id });
  });

  it('线索转化与导入不发通知 / conversion and import do not notify', async () => {
    const l = await post(leads, { name: 'L1', company: '乙公司', ownerId: s.user.id });
    expect(await count(s.token)).toBe(1);
    expect((await call(leadConvert.POST, { token: a.token, body: { account: { mode: 'new' }, deal: { name: '乙公司商机' } }, params: { id: l.id } })).status).toBe(200);
    const imported = await call(leadImport.POST, { token: a.token, body: { csv: `姓名,负责人邮箱\n导入一,${s.user.email}`, dryRun: false } });
    expect(imported.status).toBe(200);
    expect(imported.json.created).toBe(1);
    expect(await count(s.token)).toBe(1);
  });

  it('已读、删除等收件箱操作不写审计 / inbox actions are not audited', async () => {
    await post(leads, { name: 'L1', ownerId: s.user.id });
    const before = await prisma.auditLog.count();
    await call(read.POST, { token: s.token, body: { all: true } });
    await call(clearRead.POST, { token: s.token });
    expect(await prisma.auditLog.count()).toBe(before);
  });
});

describe('notifications R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET/POST/DELETE / preflight allows the methods used', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await one.OPTIONS(new Request('http://localhost/api/notifications/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    for (const m of ['GET', 'POST', 'DELETE']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
  });
});
