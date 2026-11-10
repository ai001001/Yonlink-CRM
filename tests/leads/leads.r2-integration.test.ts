/**
 * 线索 第二轮：集成测试（数据库关系、异常输入、边界条件、组织隔离）。
 * Leads round 2: integration tests (DB relations, invalid input, boundaries, organization isolation).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as collection from '@/app/api/leads/route';
import * as item from '@/app/api/leads/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

describe('leads R2 invalid input & boundaries', () => {
  it.each([
    ['缺少姓名 / missing name', {}],
    ['空白姓名 / blank name', { name: '   ' }],
    ['姓名超长 / name too long', { name: 'x'.repeat(101) }],
    ['邮箱非法 / bad email', { name: 'a', email: 'not-an-email' }],
    ['状态非法 / bad status', { name: 'a', status: 'WON' }],
    ['来源非法 / bad source', { name: 'a', source: 'TV' }],
    ['负责人非 UUID / owner not uuid', { name: 'a', ownerId: '123' }],
    ['类型错误 / wrong type', { name: 123 }],
  ])('%s → 400', async (_label, body) => {
    const res = await call(collection.POST, { token: a.token, body });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.lead.count()).toBe(0);
  });

  it('非 JSON 请求体 → 400 / non-JSON body', async () => {
    const res = await call(collection.POST, { token: a.token, rawBody: '{oops' });
    expect(res.status).toBe(400);
  });

  it('姓名恰好 100 字符可保存，首尾空白被去除 / exactly 100 chars accepted, whitespace trimmed', async () => {
    const res = await call(collection.POST, { token: a.token, body: { name: `  ${'名'.repeat(100)}  ` } });
    expect(res.status).toBe(201);
    expect(res.json.name).toBe('名'.repeat(100));
  });

  it('字段错误按字段返回 / field errors are keyed by field', async () => {
    const res = await call(collection.POST, { token: a.token, body: { email: 'bad' } });
    expect(Object.keys(res.json.error.details).sort()).toEqual(['email', 'name']);
  });

  it.each([
    [{ page: '0' }],
    [{ pageSize: '101' }],
    [{ page: 'abc' }],
    [{ status: 'nope' }],
    [{ q: 'x'.repeat(101) }],
  ])('非法查询参数 %j → 400 / bad query params', async (query) => {
    expect((await call(collection.GET, { token: a.token, query })).status).toBe(400);
  });

  it('超出最后一页返回空列表但 total 正确 / page past the end is empty with correct total', async () => {
    await call(collection.POST, { token: a.token, body: { name: '一' } });
    const res = await call(collection.GET, { token: a.token, query: { page: '5' } });
    expect(res.json).toMatchObject({ items: [], total: 1, page: 5 });
  });

  it('搜索中的 SQL/LIKE 特殊字符按字面处理 / SQL & LIKE metacharacters are literal', async () => {
    await call(collection.POST, { token: a.token, body: { name: '普通线索' } });
    for (const q of ["' OR 1=1 --", '%', '_', '\\', '线_']) {
      const res = await call(collection.GET, { token: a.token, query: { q } });
      expect(res.status).toBe(200);
      expect(res.json.total).toBe(0);
    }
  });

  it('非法 id 视为不存在 / malformed id is 404', async () => {
    expect((await call(item.GET, { token: a.token, params: { id: 'abc' } })).status).toBe(404);
    expect((await call(item.GET, { token: a.token, params: { id: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
  });

  it('删除线索时关联跟进记录级联删除 / deleting a lead cascades its activities', async () => {
    const lead = await call(collection.POST, { token: a.token, body: { name: '有跟进' } });
    await prisma.activity.create({ data: { organizationId: a.org.id, type: 'CALL', subject: '首次电话', leadId: lead.json.id } });
    await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: lead.json.id } });
    expect(await prisma.activity.count()).toBe(0);
  });
});

describe('leads R2 organization isolation', () => {
  it('未登录不可访问 / unauthenticated requests are rejected', async () => {
    expect((await call(collection.GET)).status).toBe(401);
    expect((await call(collection.POST, { body: { name: 'x' } })).status).toBe(401);
  });

  it('列表与搜索只返回本组织数据 / list and search are organization scoped', async () => {
    await call(collection.POST, { token: a.token, body: { name: '共同名字' } });
    await call(collection.POST, { token: b.token, body: { name: '共同名字' } });
    const res = await call(collection.GET, { token: a.token, query: { q: '共同' } });
    expect(res.json.total).toBe(1);
    expect(res.json.items[0].organizationId).toBe(a.org.id);
  });

  it('篡改 ID 访问其他组织线索：读/改/删均为 404 且数据不变 / IDOR read/update/delete → 404, data untouched', async () => {
    const other = await call(collection.POST, { token: b.token, body: { name: 'B 的线索' } });
    const id = other.json.id;
    expect((await call(item.GET, { token: a.token, params: { id } })).status).toBe(404);
    expect((await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id }, body: { name: '被篡改' } })).status).toBe(404);
    expect((await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id } })).status).toBe(404);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe('B 的线索');
  });

  it('不能把负责人设为其他组织用户 / owner from another organization is rejected', async () => {
    const res = await call(collection.POST, { token: a.token, body: { name: 'x', ownerId: b.user.id } });
    expect(res.status).toBe(400);
    expect(res.json.error.details.ownerId).toBeDefined();
    const own = await call(collection.POST, { token: a.token, body: { name: 'y' } });
    const upd = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: own.json.id }, body: { ownerId: b.user.id } });
    expect(upd.status).toBe(400);
  });

  it('请求体中的 organizationId/id 等字段被拒绝 / organizationId or id in the body is rejected', async () => {
    expect((await call(collection.POST, { token: a.token, body: { name: 'x', organizationId: b.org.id } })).status).toBe(400);
    expect((await call(collection.POST, { token: a.token, body: { name: 'x', id: '00000000-0000-4000-8000-000000000000' } })).status).toBe(400);
    expect(await prisma.lead.count({ where: { organizationId: b.org.id } })).toBe(0);
  });

  it('数据库复合外键阻止跨组织负责人（纵深防御）/ composite FK blocks cross-org owner at DB level', async () => {
    await expect(
      prisma.lead.create({ data: { organizationId: a.org.id, ownerId: b.user.id, name: '绕过服务层' } }),
    ).rejects.toThrow();
  });
});

describe('leads R2 search literal wildcards (regression for R2 defect)', () => {
  it('包含 % 的真实名字仍可被搜索到 / names containing % are still found', async () => {
    await resetDb();
    const t = await createTenant('C');
    await call(collection.POST, { token: t.token, body: { name: '折扣100%客户' } });
    await call(collection.POST, { token: t.token, body: { name: '普通客户' } });
    const res = await call(collection.GET, { token: t.token, query: { q: '100%' } });
    expect(res.json.items.map((l: { name: string }) => l.name)).toEqual(['折扣100%客户']);
  });
});
