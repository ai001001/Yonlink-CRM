/**
 * 销售目标与预测 第二轮：集成测试（角色可见范围与修改权限、组织隔离、异常参数、数据库约束、并发设定、未登录）。
 * Sales targets and forecast round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as forecasts from '@/app/api/forecasts/route';
import * as targets from '@/app/api/forecasts/targets/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { fixtures } from '../reports/fixtures';

type Who = { user: { id: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
const put = (who: { token: string }, body: object) => call(targets.PUT, { token: who.token, method: 'PUT', body: { currency: 'CNY', month: '2026-11', ...body } });
const get = (who: { token: string }, query: Record<string, string> = { period: '2026-11' }) => call(forecasts.GET, { token: who.token, query });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  const f = await fixtures(admin.org.id);
  await f.deal('CLOSED_WON', '100', { ownerId: sales1.user.id, close: '2026-11-05' });
  await f.deal('CLOSED_WON', '300', { ownerId: sales2.user.id, close: '2026-11-06' });
  await f.deal('PROPOSAL', '50', { close: '2026-11-07' });
  await put(admin, { userId: sales1.user.id, amount: '1000' });
  await put(admin, { userId: sales2.user.id, amount: '2000' });
});

describe('forecasts R2 permissions', () => {
  it('销售代表只看到自己一行，合计等于自己；不能编辑 / sales reps see only themselves', async () => {
    const r = (await get(sales1)).json;
    expect(r.rows.map((x: { ownerId: string }) => x.ownerId)).toEqual([sales1.user.id]);
    expect(r.rows[0]).toMatchObject({ target: '1000.00', won: '100.00' });
    expect(r.totals).toMatchObject({ target: '1000.00', won: '100.00', open: '0.00' });
    expect(r.canEdit).toBe(false);
    expect((await put(sales1, { userId: sales1.user.id, amount: '1' })).status).toBe(403);
  });

  it('只读看全部不能改；经理与管理员可改 / read-only views all, managers edit', async () => {
    const r = (await get(viewer)).json;
    expect(r.totals).toMatchObject({ target: '3000.00', won: '400.00', open: '50.00' });
    expect(r.canEdit).toBe(false);
    expect((await put(viewer, { userId: sales1.user.id, amount: '1' })).status).toBe(403);
    expect((await put(manager, { userId: sales1.user.id, amount: '1500' })).status).toBe(200);
    expect((await get(manager)).json.canEdit).toBe(true);
  });
});

describe('forecasts R2 isolation & input', () => {
  it('跨组织：不能给他组织用户设目标，他组织看不到本组织数据 / cross-org isolation', async () => {
    const other = await createTenant('B', 'ADMIN');
    const r = await put(other, { userId: sales1.user.id, amount: '1' });
    expect(r.status).toBe(400);
    expect(r.json.error.details.userId).toEqual(['not_found']);
    const b = (await get(other)).json;
    expect(b.rows.map((x: { ownerId: string }) => x.ownerId)).toEqual([other.user.id]);
    expect(b.totals).toMatchObject({ target: null, won: '0.00', open: '0.00' });
  });

  it.each([[{ period: '2026-1' }], [{ period: '2026-Q5' }], [{ period: '2026/11' }], [{ period: '' }], [{ currency: 'GBP' }], [{ ownerId: 'x' }]])(
    '非法预测参数 %j → 400 / invalid forecast query',
    async (query) => {
      expect((await get(admin, query as Record<string, string>)).status).toBe(400);
    },
  );

  it.each([
    [{ month: '2026-13' }],
    [{ month: '2026-11-01' }],
    [{ amount: '-1' }],
    [{ amount: '1.234' }],
    [{ amount: 'abc' }],
    [{ amount: undefined }],
    [{ currency: 'GBP' }],
    [{ userId: 'x' }],
    [{ organizationId: '00000000-0000-4000-8000-000000000000' }],
  ])('非法目标参数 %j → 400 / invalid target input', async (extra) => {
    const body = { userId: sales1.user.id, amount: '1', ...extra };
    if ('amount' in extra && extra.amount === undefined) delete (body as Record<string, unknown>).amount;
    expect((await put(admin, body)).status).toBe(400);
  });

  it('数据库约束：月份须为 1 日、金额非负、币种格式、唯一、不能跨组织 / DB constraints', async () => {
    const base = { organizationId: admin.org.id, userId: sales1.user.id, currency: 'CNY', amount: '1' };
    await expect(prisma.salesTarget.create({ data: { ...base, month: new Date('2026-12-15T00:00:00Z') } })).rejects.toThrow();
    await expect(prisma.salesTarget.create({ data: { ...base, month: new Date('2026-12-01T00:00:00Z'), amount: '-1' } })).rejects.toThrow();
    await expect(prisma.salesTarget.create({ data: { ...base, month: new Date('2026-12-01T00:00:00Z'), currency: 'cny' } })).rejects.toThrow();
    await expect(prisma.salesTarget.create({ data: { ...base, month: new Date('2026-11-01T00:00:00Z') } })).rejects.toThrow();
    const other = await createTenant('B', 'ADMIN');
    await expect(prisma.salesTarget.create({ data: { ...base, organizationId: other.org.id, month: new Date('2026-12-01T00:00:00Z') } })).rejects.toThrow();
  });

  it('并发设定同一目标：最终只有一行 / concurrent sets keep one row', async () => {
    const res = await Promise.all([put(admin, { userId: manager.user.id, amount: '10' }), put(manager, { userId: manager.user.id, amount: '20' })]);
    for (const r of res) expect([200, 409]).toContain(r.status);
    expect(await prisma.salesTarget.count({ where: { userId: manager.user.id } })).toBe(1);
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(forecasts.GET)).status).toBe(401);
    expect((await call(targets.PUT, { method: 'PUT', body: { userId: sales1.user.id, month: '2026-11', currency: 'CNY', amount: '1' } })).status).toBe(401);
  });
});
