/**
 * 线索 第一轮：功能测试（新增、编辑、删除、详情、搜索、分页、保存）。
 * Leads round 1: functional tests (create, edit, delete, detail, search, paging, persistence).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as collection from '@/app/api/leads/route';
import * as item from '@/app/api/leads/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

const full = {
  name: '张三',
  company: '上海星河科技有限公司',
  title: '采购经理',
  phone: '021-55550000',
  mobile: '13800000000',
  email: 'ZhangSan@Example.com',
  source: 'EXHIBITION',
  status: 'CONTACTED',
  description: '展会上交换名片',
};

describe('leads R1 functional', () => {
  it('新增线索并持久化全部字段，负责人默认当前用户 / create persists all fields, owner defaults to me', async () => {
    const res = await call(collection.POST, { token: a.token, body: full });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ ...full, email: 'zhangsan@example.com', ownerId: a.user.id, organizationId: a.org.id });
    expect(res.json.owner.name).toBe(a.user.name);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: res.json.id } });
    expect(row.company).toBe(full.company);
    expect(row.status).toBe('CONTACTED');
  });

  it('只填姓名即可创建，默认状态为新线索 / name only is enough, default status NEW', async () => {
    const res = await call(collection.POST, { token: a.token, body: { name: '李四' } });
    expect(res.status).toBe(201);
    expect(res.json.status).toBe('NEW');
    expect(res.json.company).toBeNull();
  });

  it('查看详情 / get detail', async () => {
    const created = await call(collection.POST, { token: a.token, body: full });
    const res = await call(item.GET, { token: a.token, params: { id: created.json.id } });
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('张三');
  });

  it('编辑线索：部分更新、清空字段、修改状态 / partial update, clearing fields, status change', async () => {
    const created = await call(collection.POST, { token: a.token, body: full });
    const res = await call(item.PATCH, {
      token: a.token,
      method: 'PATCH',
      params: { id: created.json.id },
      body: { status: 'QUALIFIED', company: '', phone: null },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'QUALIFIED', company: null, phone: null, name: '张三', mobile: full.mobile });
  });

  it('可将负责人改为本组织其他用户或取消分配 / reassign owner within org or unassign', async () => {
    const colleague = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'colleague@yonlink.test', name: '同事', passwordHash: 'x' },
    });
    const created = await call(collection.POST, { token: a.token, body: { name: '王五', ownerId: colleague.id } });
    expect(created.json.ownerId).toBe(colleague.id);
    const cleared = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: created.json.id }, body: { ownerId: null } });
    expect(cleared.json.ownerId).toBeNull();
  });

  it('删除线索 / delete', async () => {
    const created = await call(collection.POST, { token: a.token, body: full });
    const del = await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: created.json.id } });
    expect(del.status).toBe(204);
    expect(await prisma.lead.count()).toBe(0);
    expect((await call(item.GET, { token: a.token, params: { id: created.json.id } })).status).toBe(404);
  });

  it('搜索：姓名、公司、邮箱、手机，不区分大小写 / search name, company, email, mobile case-insensitively', async () => {
    await call(collection.POST, { token: a.token, body: full });
    await call(collection.POST, { token: a.token, body: { name: '赵六', company: 'Acme Corp', email: 'zl@acme.io' } });
    const q = async (q: string) => (await call(collection.GET, { token: a.token, query: { q } })).json.items.map((l: { name: string }) => l.name);
    expect(await q('张')).toEqual(['张三']);
    expect(await q('星河')).toEqual(['张三']);
    expect(await q('ACME')).toEqual(['赵六']);
    expect(await q('13800000000')).toEqual(['张三']);
    expect(await q('不存在')).toEqual([]);
  });

  it('按状态和来源筛选 / filter by status and source', async () => {
    await call(collection.POST, { token: a.token, body: full });
    await call(collection.POST, { token: a.token, body: { name: '赵六', source: 'WEBSITE' } });
    const byStatus = await call(collection.GET, { token: a.token, query: { status: 'CONTACTED' } });
    expect(byStatus.json.total).toBe(1);
    const bySource = await call(collection.GET, { token: a.token, query: { source: 'WEBSITE' } });
    expect(bySource.json.items[0].name).toBe('赵六');
  });

  it('分页：总数、页码、最新优先 / paging: totals, pages, newest first', async () => {
    for (let i = 1; i <= 25; i++) await call(collection.POST, { token: a.token, body: { name: `线索${String(i).padStart(2, '0')}` } });
    const p1 = await call(collection.GET, { token: a.token, query: { page: '1', pageSize: '10' } });
    const p3 = await call(collection.GET, { token: a.token, query: { page: '3', pageSize: '10' } });
    expect(p1.json.total).toBe(25);
    expect(p1.json.items).toHaveLength(10);
    expect(p1.json.items[0].name).toBe('线索25');
    expect(p3.json.items).toHaveLength(5);
    const all = new Set([...p1.json.items, ...p3.json.items].map((l: { id: string }) => l.id));
    expect(all.size).toBe(15);
  });
});
