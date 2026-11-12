/**
 * 跟进日历 第一轮：功能测试（时间范围边界、排序、筛选、条数上限、改期、视图日期计算、演示数据）。
 * Activity calendar round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as activityItem from '@/app/api/activities/[id]/route';
import * as calendar from '@/app/api/activities/calendar/route';
import { mondayOf, visibleDays } from '@/components/ActivityCalendar';
import { prisma } from '@/server/db';
import { CALENDAR_LIMIT } from '@/server/modules/activities';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const RANGE = { from: '2026-11-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00' };
const mk = (subject: string, dueAt: string | null, extra: Record<string, unknown> = {}) =>
  prisma.activity.create({ data: { organizationId: a.org.id, type: 'CALL', subject, dueAt: dueAt ? new Date(dueAt) : null, ownerId: a.user.id, ...extra } });
const get = async (query: Record<string, string> = {}) => {
  const res = await call(calendar.GET, { token: a.token, query: { ...RANGE, ...query } });
  expect(res.status).toBe(200);
  return res.json as { items: { subject: string; dueAt: string; owner: { id: string } | null }[]; truncated: boolean };
};

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('calendar R1 range', () => {
  it('按截止时间 [from, to) 返回，含开始、不含结束，排除无截止时间，升序 / half-open range, ascending', async () => {
    await mk('结束边界', '2026-11-30T16:00:00Z');
    await mk('月中', '2026-11-15T02:00:00Z');
    await mk('开始边界', '2026-10-31T16:00:00Z');
    await mk('开始前', '2026-10-31T15:59:59Z');
    await mk('无截止', null);
    const r = await get();
    expect(r.items.map((i) => i.subject)).toEqual(['开始边界', '月中']);
    expect(r.truncated).toBe(false);
    expect(r.items[0]).toMatchObject({ owner: { id: a.user.id } });
  });

  it('筛选：类型、完成状态、负责人 / filters', async () => {
    const u = await addUser(a.org.id, 'SALES', '乙');
    await mk('电话', '2026-11-10T01:00:00Z');
    await mk('会议', '2026-11-11T01:00:00Z', { type: 'MEETING' });
    await mk('已完成', '2026-11-12T01:00:00Z', { completed: true, completedAt: new Date() });
    await mk('乙的', '2026-11-13T01:00:00Z', { ownerId: u.user.id });
    expect((await get({ type: 'MEETING' })).items.map((i) => i.subject)).toEqual(['会议']);
    expect((await get({ completed: 'true' })).items.map((i) => i.subject)).toEqual(['已完成']);
    expect((await get({ completed: 'false' })).items).toHaveLength(3);
    expect((await get({ ownerId: u.user.id })).items.map((i) => i.subject)).toEqual(['乙的']);
  });

  it(`超过 ${CALENDAR_LIMIT} 条：只返回前 ${CALENDAR_LIMIT} 条并标记 truncated / limit`, async () => {
    const base = new Date('2026-11-05T00:00:00Z').getTime();
    await prisma.activity.createMany({
      data: Array.from({ length: CALENDAR_LIMIT + 1 }, (_, i) => ({ organizationId: a.org.id, type: 'TASK' as const, subject: `任务${i}`, dueAt: new Date(base + i * 60_000) })),
    });
    const r = await get();
    expect(r.items).toHaveLength(CALENDAR_LIMIT);
    expect(r.truncated).toBe(true);
    expect(r.items[0]!.subject).toBe('任务0');
  });
});

describe('calendar R1 reschedule & view maths', () => {
  it('拖动改期：PATCH dueAt 保留时间点，写审计 / reschedule keeps the time of day', async () => {
    const act = await mk('改期', '2026-11-10T06:30:00Z');
    const res = await call(activityItem.PATCH, { token: a.token, method: 'PATCH', params: { id: act.id }, body: { dueAt: '2026-11-12T06:30:00.000Z' } });
    expect(res.status).toBe(200);
    expect(res.json.dueAt).toBe('2026-11-12T06:30:00.000Z');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'activity.update', entityId: act.id } });
    expect(log.changes).toMatchObject({ fields: { dueAt: ['2026-11-10T06:30:00.000Z', '2026-11-12T06:30:00.000Z'] } });
    expect((await get()).items.map((i) => i.dueAt)).toEqual(['2026-11-12T06:30:00.000Z']);
  });

  it('周一起始；月视图 42 天覆盖整月；周视图 7 天 / Monday-based views', () => {
    expect(mondayOf(dayjs('2026-11-15')).format('YYYY-MM-DD')).toBe('2026-11-09');
    expect(mondayOf(dayjs('2026-11-09')).format('YYYY-MM-DD')).toBe('2026-11-09');
    const month = visibleDays('month', dayjs('2026-11-20'));
    expect(month).toHaveLength(42);
    expect(month[0]!.format('YYYY-MM-DD')).toBe('2026-10-26');
    expect(month[41]!.format('YYYY-MM-DD')).toBe('2026-12-06');
    const feb = visibleDays('month', dayjs('2027-02-10'));
    expect(feb[0]!.format('YYYY-MM-DD')).toBe('2027-02-01');
    const week = visibleDays('week', dayjs('2026-11-15'));
    expect(week.map((d) => d.format('MM-DD'))).toEqual(['11-09', '11-10', '11-11', '11-12', '11-13', '11-14', '11-15']);
  });

  it('演示数据：当前月视图范围内有跟进 / demo data has activities in the current month view', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const { token } = await addUser(org.id, 'READONLY', 'CALVIEW');
    const days = visibleDays('month', dayjs());
    const res = await call(calendar.GET, { token, query: { from: days[0]!.toISOString(), to: days[41]!.add(1, 'day').toISOString() } });
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBeGreaterThan(5);
    expect(res.json.items.some((i: { completed: boolean; dueAt: string }) => !i.completed && new Date(i.dueAt) < new Date())).toBe(true);
  });
});
