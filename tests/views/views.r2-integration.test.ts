/**
 * 保存的视图 第二轮：集成测试（角色与共享权限、只有创建者可改、删除规则、共享不扩大可见范围、组织隔离、上限、异常输入、数据库约束）。
 * Saved views round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as leads from '@/app/api/leads/route';
import * as defaults from '@/app/api/views/default/route';
import * as viewItem from '@/app/api/views/[id]/route';
import * as views from '@/app/api/views/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
const create = (who: { token: string }, body: object) => call(views.POST, { token: who.token, body: { entity: 'leads', filters: {}, ...body } });
const patch = (who: { token: string }, id: string, body: object) => call(viewItem.PATCH, { token: who.token, method: 'PATCH', params: { id }, body });
const remove = (who: { token: string }, id: string) => call(viewItem.DELETE, { token: who.token, method: 'DELETE', params: { id } });
const setDefault = (who: { token: string }, viewId: string | null, entity = 'leads') => call(defaults.PUT, { token: who.token, method: 'PUT', body: { entity, viewId } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('views R2 permissions', () => {
  it('私有视图人人可建；共享仅管理员与经理 / private for all, sharing for admins and managers', async () => {
    for (const who of [viewer, sales1]) {
      expect((await create(who, { name: '私有' })).status).toBe(201);
      expect((await create(who, { name: '共享', shared: true })).status).toBe(403);
    }
    expect((await create(manager, { name: '经理共享', shared: true })).status).toBe(201);
    const priv = (await create(sales1, { name: '想共享' })).json;
    expect((await patch(sales1, priv.id, { shared: true })).status).toBe(403);
  });

  it('只有创建者能修改；他人私有视图不可见（404）/ only the creator edits', async () => {
    const shared = (await create(admin, { name: '共享', shared: true })).json;
    const priv = (await create(admin, { name: '私有' })).json;
    expect((await patch(manager, shared.id, { name: '改名' })).status).toBe(403);
    expect((await patch(manager, priv.id, { name: '改名' })).status).toBe(404);
    expect((await call(views.GET, { token: manager.token, query: { entity: 'leads' } })).json.items.map((v: { id: string }) => v.id)).toEqual([shared.id]);
  });

  it('删除：创建者可以；共享视图也可由管理员/经理删除；销售不能删他人共享视图 / delete rules', async () => {
    const byAdmin = (await create(admin, { name: '管理员共享', shared: true })).json;
    expect((await remove(sales1, byAdmin.id)).status).toBe(403);
    expect((await remove(manager, byAdmin.id)).status).toBe(204);
    const priv = (await create(sales2, { name: '销售私有' })).json;
    expect((await remove(admin, priv.id)).status).toBe(404);
    expect((await remove(sales2, priv.id)).status).toBe(204);
  });

  it('默认视图只能设为自己可见的视图 / defaults must be visible', async () => {
    const priv = (await create(sales2, { name: '销售私有' })).json;
    const shared = (await create(admin, { name: '共享', shared: true })).json;
    expect((await setDefault(sales1, priv.id)).status).toBe(404);
    expect((await setDefault(sales1, shared.id)).status).toBe(200);
    expect((await setDefault(viewer, shared.id)).status).toBe(200);
  });

  it('共享视图不扩大可见范围：销售套用含他人负责人的视图仍看不到 / sharing never widens visibility', async () => {
    await call(leads.POST, { token: sales2.token, body: { name: '销售2的线索' } });
    const v = (await create(manager, { name: '销售2的线索', shared: true, filters: { ownerId: sales2.user.id } })).json;
    const asSales1 = await call(leads.GET, { token: sales1.token, query: v.filters });
    expect(asSales1.json.total).toBe(0);
    expect((await call(leads.GET, { token: manager.token, query: v.filters })).json.total).toBe(1);
  });
});

describe('views R2 isolation, limits & input', () => {
  it('跨组织：看不到、改不了、删不了、不能设为默认 / cross-org isolation', async () => {
    const shared = (await create(admin, { name: '共享', shared: true })).json;
    const other = await createTenant('B', 'ADMIN');
    expect((await call(views.GET, { token: other.token, query: { entity: 'leads' } })).json.items).toEqual([]);
    expect((await patch(other, shared.id, { name: 'x' })).status).toBe(404);
    expect((await remove(other, shared.id)).status).toBe(404);
    expect((await setDefault(other, shared.id)).status).toBe(404);
  });

  it('每人每个列表最多 50 个 / limit per user and list', async () => {
    await prisma.savedView.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ organizationId: admin.org.id, ownerId: sales1.user.id, entity: 'leads' as const, name: `v${i}`, filters: {} })) });
    const r = await create(sales1, { name: '第51个' });
    expect(r.status).toBe(400);
    expect(r.json.error.details.name).toEqual(['limit']);
    expect((await create(sales1, { name: '其他列表', entity: 'deals' })).status).toBe(201);
    expect((await create(sales2, { name: '他人' })).status).toBe(201);
  });

  it.each([
    [{ name: '' }],
    [{ name: '   ' }],
    [{ name: 'x'.repeat(51) }],
    [{ name: 'ok', entity: 'quotes' }],
    [{ name: 'ok', filters: [] }],
    [{ name: 'ok', filters: 'status=NEW' }],
    [{ name: 'ok', filters: { status: 'NEW', page: '2' } }],
    [{ name: 'ok', shared: 'yes' }],
    [{ name: 'ok', ownerId: '00000000-0000-4000-8000-000000000000' }],
    [{ name: 'ok', organizationId: '00000000-0000-4000-8000-000000000000' }],
  ])('非法视图 %j → 400 / invalid view input', async (body) => {
    expect((await create(admin, body)).status).toBe(400);
  });

  it('非法查询、默认与修改参数 → 400；未登录 401 / invalid queries and auth', async () => {
    const v = (await create(admin, { name: '视图' })).json;
    expect((await call(views.GET, { token: admin.token })).status).toBe(400);
    expect((await call(views.GET, { token: admin.token, query: { entity: 'leads', extra: '1' } })).status).toBe(400);
    expect((await call(defaults.PUT, { token: admin.token, method: 'PUT', body: { entity: 'leads' } })).status).toBe(400);
    expect((await patch(admin, v.id, { ownerId: sales1.user.id })).status).toBe(400);
    expect((await call(views.GET, { query: { entity: 'leads' } })).status).toBe(401);
    expect((await call(defaults.PUT, { method: 'PUT', body: { entity: 'leads', viewId: null } })).status).toBe(401);
  });

  it('数据库约束：筛选必须是对象、名称非空、默认视图不能跨组织 / DB constraints', async () => {
    await expect(prisma.savedView.create({ data: { organizationId: admin.org.id, ownerId: admin.user.id, entity: 'leads', name: 'x', filters: [] } })).rejects.toThrow();
    await expect(prisma.savedView.create({ data: { organizationId: admin.org.id, ownerId: admin.user.id, entity: 'leads', name: ' ', filters: {} } })).rejects.toThrow();
    const v = (await create(admin, { name: '视图' })).json;
    const other = await createTenant('B', 'ADMIN');
    await expect(prisma.userViewDefault.create({ data: { organizationId: other.org.id, userId: other.user.id, entity: 'leads', viewId: v.id } })).rejects.toThrow();
  });
});
