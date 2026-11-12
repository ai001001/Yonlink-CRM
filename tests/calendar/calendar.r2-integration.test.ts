/**
 * 跟进日历 第二轮：集成测试（角色可见范围、负责人筛选越权、改期权限、组织隔离、异常参数）。
 * Activity calendar round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as activityItem from '@/app/api/activities/[id]/route';
import * as calendar from '@/app/api/activities/calendar/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let act1: { id: string };
let act2: { id: string };
const RANGE = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' };
const get = (who: { token: string }, query: Record<string, string> = {}) => call(calendar.GET, { token: who.token, query: { ...RANGE, ...query } });
const subjects = async (who: { token: string }, query: Record<string, string> = {}) =>
  ((await get(who, query)).json.items as { subject: string }[]).map((i) => i.subject).sort();

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  const mk = (subject: string, ownerId: string | null) =>
    prisma.activity.create({ data: { organizationId: admin.org.id, type: 'CALL', subject, ownerId, dueAt: new Date('2026-11-10T02:00:00Z') } });
  act1 = await mk('销售1', sales1.user.id);
  act2 = await mk('销售2', sales2.user.id);
  await mk('未分配', null);
});

describe('calendar R2 visibility', () => {
  it('销售代表只看到自己的；指定他人为负责人为空 / sales reps see their own only', async () => {
    expect(await subjects(sales1)).toEqual(['销售1']);
    expect(await subjects(sales1, { ownerId: sales2.user.id })).toEqual([]);
  });

  it('只读与管理员看到全部，可按负责人筛选 / read-only and admins see everything', async () => {
    expect(await subjects(viewer)).toEqual(['未分配', '销售1', '销售2']);
    expect(await subjects(admin)).toEqual(['未分配', '销售1', '销售2']);
    expect(await subjects(viewer, { ownerId: sales2.user.id })).toEqual(['销售2']);
  });

  it('改期权限：本人可以；他人 404；只读 403；经理可以 / reschedule rights', async () => {
    const patch = (who: Who | typeof admin, id: string) =>
      call(activityItem.PATCH, { token: who.token, method: 'PATCH', params: { id }, body: { dueAt: '2026-11-20T02:00:00Z' } });
    expect((await patch(sales1, act1.id)).status).toBe(200);
    expect((await patch(sales1, act2.id)).status).toBe(404);
    expect((await patch(viewer, act2.id)).status).toBe(403);
    const manager = await addUser(admin.org.id, 'MANAGER');
    expect((await patch(manager, act2.id)).status).toBe(200);
    expect((await prisma.activity.findUniqueOrThrow({ where: { id: act2.id } })).dueAt?.toISOString()).toBe('2026-11-20T02:00:00.000Z');
  });

  it('跨组织：看不到，改不了 / cross-org isolation', async () => {
    const other = await createTenant('B', 'ADMIN');
    expect(await subjects(other)).toEqual([]);
    expect(await subjects(other, { ownerId: sales1.user.id })).toEqual([]);
    const res = await call(activityItem.PATCH, { token: other.token, method: 'PATCH', params: { id: act1.id }, body: { dueAt: '2026-11-20T02:00:00Z' } });
    expect(res.status).toBe(404);
  });
});

describe('calendar R2 input', () => {
  it.each([
    [{ from: '' }],
    [{ from: '2026-11-01' }],
    [{ from: '2026-11-01T00:00:00' }],
    [{ to: '2026-11-01T00:00:00Z' }],
    [{ to: '2026-10-01T00:00:00Z' }],
    [{ to: '2026-12-14T00:00:01Z' }],
    [{ type: 'EMAIL' }],
    [{ completed: 'yes' }],
    [{ ownerId: 'nobody' }],
    [{ organizationId: '00000000-0000-4000-8000-000000000000' }],
    [{ page: '2' }],
  ])('非法参数 %j → 400 / invalid query', async (query) => {
    expect((await get(admin, query as Record<string, string>)).status).toBe(400);
  });

  it('43 天以内（含夏令时余量）可查询；缺少参数 400；未登录 401 / limits, missing params, auth', async () => {
    expect((await get(admin, { to: '2026-12-14T00:00:00Z' })).status).toBe(200);
    expect((await call(calendar.GET, { token: admin.token, query: { from: RANGE.from } })).status).toBe(400);
    expect((await call(calendar.GET, { query: RANGE })).status).toBe(401);
  });

  it('改期输入：非法时间 400，不能借改期修改负责人越权 / reschedule input', async () => {
    const bad = await call(activityItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: act1.id }, body: { dueAt: '下周一' } });
    expect(bad.status).toBe(400);
    const steal = await call(activityItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: act1.id }, body: { dueAt: '2026-11-20T02:00:00Z', ownerId: sales2.user.id } });
    expect(steal.status).toBe(403);
    expect((await prisma.activity.findUniqueOrThrow({ where: { id: act1.id } })).ownerId).toBe(sales1.user.id);
  });
});
