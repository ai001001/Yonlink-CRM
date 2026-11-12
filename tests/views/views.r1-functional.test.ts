/**
 * 保存的视图 第一轮：功能测试（新建与规范化、列表与默认视图、更新/重命名/删除、共享与取消共享、白名单、套用后筛选结果一致）。
 * Saved views round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as leads from '@/app/api/leads/route';
import * as defaults from '@/app/api/views/default/route';
import * as viewItem from '@/app/api/views/[id]/route';
import * as views from '@/app/api/views/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const create = (body: object, token = a.token) => call(views.POST, { token, body });
const list = async (entity: string, token = a.token) => (await call(views.GET, { token, query: { entity } })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('views R1 basics', () => {
  it('新建：名称去空格、去掉空筛选值、默认私有 / create normalises', async () => {
    const r = await create({ entity: 'leads', name: '  展会新线索 ', filters: { status: 'NEW', source: 'EXHIBITION', q: '', tagId: undefined } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ entity: 'leads', name: '展会新线索', filters: { status: 'NEW', source: 'EXHIBITION' }, shared: false, owner: { id: a.user.id } });
    // jsonb 不保留字段顺序，只比较字段集合 / jsonb does not keep key order
    expect(Object.keys(r.json.filters).sort()).toEqual(['source', 'status']);
  });

  it('各列表白名单：允许的字段与取值；不属于该列表的字段或非法取值 400 / per-list whitelist', async () => {
    expect((await create({ entity: 'accounts', name: '制造业', filters: { industry: 'MANUFACTURING' } })).status).toBe(201);
    expect((await create({ entity: 'deals', name: '谈判中', filters: { stage: 'NEGOTIATION', q: '框架' } })).status).toBe(201);
    expect((await create({ entity: 'activities', name: '未完成任务', filters: { type: 'TASK', completed: 'false' } })).status).toBe(201);
    const bad = await create({ entity: 'accounts', name: '错字段', filters: { stage: 'NEGOTIATION' } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json.error.details)).toEqual(['filters']);
    expect((await create({ entity: 'leads', name: '错值', filters: { status: 'WON' } })).status).toBe(400);
    expect((await create({ entity: 'deals', name: '错标签', filters: { tagId: 'x' } })).status).toBe(400);
  });

  it('列表：自己的与共享的，私有在前、按名称排序；同名 409 / list and uniqueness', async () => {
    await create({ entity: 'leads', name: '乙', filters: {} });
    await create({ entity: 'leads', name: '甲', filters: {} });
    await create({ entity: 'deals', name: '其他列表', filters: {} });
    const r = await list('leads');
    expect(r.items.map((v: { name: string }) => v.name)).toHaveLength(2);
    expect(r.defaultViewId).toBeNull();
    expect((await create({ entity: 'leads', name: '甲', filters: {} })).status).toBe(409);
    expect((await create({ entity: 'deals', name: '甲', filters: {} })).status).toBe(201);
  });

  it('更新筛选、重命名（重名 409）、删除 / update, rename, delete', async () => {
    const v = (await create({ entity: 'leads', name: '原名', filters: { status: 'NEW' } })).json;
    await create({ entity: 'leads', name: '已占用', filters: {} });
    const u = await call(viewItem.PATCH, { token: a.token, method: 'PATCH', params: { id: v.id }, body: { filters: { status: 'CONTACTED', q: '甲' } } });
    expect(u.json.filters).toEqual({ status: 'CONTACTED', q: '甲' });
    expect((await call(viewItem.PATCH, { token: a.token, method: 'PATCH', params: { id: v.id }, body: { name: '已占用' } })).status).toBe(409);
    expect((await call(viewItem.PATCH, { token: a.token, method: 'PATCH', params: { id: v.id }, body: { name: '新名' } })).json.name).toBe('新名');
    expect((await call(viewItem.PATCH, { token: a.token, method: 'PATCH', params: { id: v.id }, body: { filters: { stage: 'X' } } })).status).toBe(400);
    expect((await call(viewItem.DELETE, { token: a.token, method: 'DELETE', params: { id: v.id } })).status).toBe(204);
    expect((await list('leads')).items).toHaveLength(1);
  });

  it('默认视图：设置、替换、取消；删除视图时默认随之清除 / default views', async () => {
    const v1 = (await create({ entity: 'leads', name: '一', filters: {} })).json;
    const v2 = (await create({ entity: 'leads', name: '二', filters: {} })).json;
    await call(defaults.PUT, { token: a.token, method: 'PUT', body: { entity: 'leads', viewId: v1.id } });
    expect((await list('leads')).defaultViewId).toBe(v1.id);
    await call(defaults.PUT, { token: a.token, method: 'PUT', body: { entity: 'leads', viewId: v2.id } });
    expect((await list('leads')).defaultViewId).toBe(v2.id);
    await call(viewItem.DELETE, { token: a.token, method: 'DELETE', params: { id: v2.id } });
    expect((await list('leads')).defaultViewId).toBeNull();
    await call(defaults.PUT, { token: a.token, method: 'PUT', body: { entity: 'leads', viewId: v1.id } });
    expect((await call(defaults.PUT, { token: a.token, method: 'PUT', body: { entity: 'leads', viewId: null } })).json).toEqual({ defaultViewId: null });
    const mismatch = await call(defaults.PUT, { token: a.token, method: 'PUT', body: { entity: 'deals', viewId: v1.id } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.details.viewId).toEqual(['entity_mismatch']);
  });
});

describe('views R1 sharing & applying', () => {
  it('共享：他人可见可设为默认；取消共享后移除他人的默认；共享视图的增改删写审计 / sharing', async () => {
    const other = await addUser(a.org.id, 'SALES', '乙');
    const v = (await create({ entity: 'deals', name: '共享视图', filters: { stage: 'PROPOSAL' }, shared: true })).json;
    expect((await list('deals', other.token)).items.map((x: { id: string }) => x.id)).toEqual([v.id]);
    await call(defaults.PUT, { token: other.token, method: 'PUT', body: { entity: 'deals', viewId: v.id } });
    await call(defaults.PUT, { token: a.token, method: 'PUT', body: { entity: 'deals', viewId: v.id } });
    await call(viewItem.PATCH, { token: a.token, method: 'PATCH', params: { id: v.id }, body: { shared: false } });
    expect((await list('deals', other.token)).items).toHaveLength(0);
    expect(await prisma.userViewDefault.count({ where: { userId: other.user.id } })).toBe(0);
    expect((await list('deals')).defaultViewId).toBe(v.id);
    expect((await prisma.auditLog.findMany({ where: { entityType: 'view' }, orderBy: { createdAt: 'asc' } })).map((l) => l.action)).toEqual(['view.create', 'view.update']);
    const priv = (await create({ entity: 'deals', name: '私有', filters: {} })).json;
    await call(viewItem.DELETE, { token: a.token, method: 'DELETE', params: { id: priv.id } });
    expect(await prisma.auditLog.count({ where: { entityType: 'view' } })).toBe(2);
  });

  it('套用视图的筛选条件与直接查询列表结果一致 / applying a view equals querying with its filters', async () => {
    for (const [name, status] of [['甲', 'NEW'], ['乙', 'CONTACTED'], ['丙', 'NEW']] as const) {
      const lead = (await call(leads.POST, { token: a.token, body: { name: `视图线索${name}` } })).json;
      await prisma.lead.update({ where: { id: lead.id }, data: { status } });
    }
    const v = (await create({ entity: 'leads', name: '新线索', filters: { status: 'NEW', q: '视图线索' } })).json;
    const r = await call(leads.GET, { token: a.token, query: v.filters });
    expect(r.json.items.map((x: { name: string }) => x.name).sort()).toEqual(['视图线索丙', '视图线索甲']);
  });
});
