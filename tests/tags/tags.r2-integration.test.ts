/**
 * 标签 第二轮：集成测试（角色权限、记录编辑权限、组织隔离、数量上限、批量逐条结果、异常输入、数据库约束、跨域 PUT 预检）。
 * Tags round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as leadBulk from '@/app/api/leads/bulk/route';
import * as leadTags from '@/app/api/leads/[id]/tags/route';
import * as leads from '@/app/api/leads/route';
import * as tagItem from '@/app/api/tags/[id]/route';
import * as tags from '@/app/api/tags/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let tag: { id: string };
let lead1: { id: string };
let lead2: { id: string };
const put = (who: { token: string }, id: string, tagIds: string[]) => call(leadTags.PUT, { token: who.token, method: 'PUT', params: { id }, body: { tagIds } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  tag = (await call(tags.POST, { token: admin.token, body: { name: '共享' } })).json;
  lead1 = (await call(leads.POST, { token: sales1.token, body: { name: '销售1线索' } })).json;
  lead2 = (await call(leads.POST, { token: sales2.token, body: { name: '销售2线索' } })).json;
});

describe('tags R2 permissions', () => {
  it('新建标签：能编辑记录的角色可以，只读 403 / create needs edit rights', async () => {
    expect((await call(tags.POST, { token: sales1.token, body: { name: '销售建' } })).status).toBe(201);
    expect((await call(tags.POST, { token: viewer.token, body: { name: '只读建' } })).status).toBe(403);
    expect((await call(tags.GET, { token: viewer.token })).json.items).toHaveLength(2);
  });

  it('改名、改色、删除：管理员与经理可以，销售与只读 403 / manage needs tag.manage', async () => {
    for (const who of [sales1, viewer]) {
      expect((await call(tagItem.PATCH, { token: who.token, method: 'PATCH', params: { id: tag.id }, body: { color: 'red' } })).status).toBe(403);
      expect((await call(tagItem.DELETE, { token: who.token, method: 'DELETE', params: { id: tag.id } })).status).toBe(403);
    }
    expect((await call(tagItem.PATCH, { token: manager.token, method: 'PATCH', params: { id: tag.id }, body: { color: 'red' } })).status).toBe(200);
    expect((await call(tagItem.DELETE, { token: manager.token, method: 'DELETE', params: { id: tag.id } })).status).toBe(204);
  });

  it('打标签遵循记录编辑权限：本人 200、他人 404、只读 403、经理 200 / tagging follows edit rights', async () => {
    expect((await put(sales1, lead1.id, [tag.id])).status).toBe(200);
    expect((await put(sales1, lead2.id, [tag.id])).status).toBe(404);
    expect((await put(viewer, lead1.id, [])).status).toBe(403);
    expect((await put(manager, lead2.id, [tag.id])).status).toBe(200);
  });

  it('使用次数与筛选遵循可见范围 / usage counts and filters follow visibility', async () => {
    await put(admin, lead1.id, [tag.id]);
    await put(admin, lead2.id, [tag.id]);
    const own = (await call(tags.GET, { token: sales1.token })).json.items[0];
    expect(own._count.leads).toBe(1);
    expect((await call(tags.GET, { token: viewer.token })).json.items[0]._count.leads).toBe(2);
    expect((await call(leads.GET, { token: sales1.token, query: { tagId: tag.id } })).json.items.map((x: { id: string }) => x.id)).toEqual([lead1.id]);
  });

  it('批量：他人记录逐条失败，自己的成功 / bulk reports per-record failures', async () => {
    const r = await call(leadBulk.POST, { token: sales1.token, body: { action: 'tag_add', ids: [lead1.id, lead2.id], tagId: tag.id } });
    expect(r.json.succeeded).toEqual([lead1.id]);
    expect(r.json.failed).toEqual([{ id: lead2.id, code: 'NOT_FOUND', message: expect.any(String) }]);
    expect((await call(leadBulk.POST, { token: viewer.token, body: { action: 'tag_add', ids: [lead1.id], tagId: tag.id } })).json.failed[0].code).toBe('FORBIDDEN');
  });
});

describe('tags R2 isolation & limits', () => {
  it('跨组织：不能使用、修改、筛选他组织标签；批量用他组织标签整批 400 / cross-org isolation', async () => {
    const other = await createTenant('B', 'ADMIN');
    const foreign = (await call(tags.POST, { token: other.token, body: { name: '共享' } })).json;
    expect(foreign.id).not.toBe(tag.id);
    const bad = await put(admin, lead1.id, [foreign.id]);
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.tagIds).toEqual(['not_found']);
    expect((await call(tagItem.PATCH, { token: other.token, method: 'PATCH', params: { id: tag.id }, body: { color: 'red' } })).status).toBe(404);
    expect((await call(tagItem.DELETE, { token: other.token, method: 'DELETE', params: { id: tag.id } })).status).toBe(404);
    expect((await call(leads.GET, { token: admin.token, query: { tagId: foreign.id } })).json.total).toBe(0);
    expect((await call(leadBulk.POST, { token: admin.token, body: { action: 'tag_add', ids: [lead1.id], tagId: foreign.id } })).status).toBe(400);
    expect((await put(other, lead1.id, [])).status).toBe(404);
    expect((await call(tags.GET, { token: other.token })).json.items).toHaveLength(1);
  });

  it('上限：每条记录 20 个、每组织 200 个 / limits', async () => {
    const ids: string[] = [tag.id];
    for (let i = 1; i < 21; i++) ids.push((await call(tags.POST, { token: admin.token, body: { name: `标签${i}` } })).json.id);
    expect((await put(admin, lead1.id, ids)).status).toBe(400);
    expect((await put(admin, lead1.id, ids.slice(0, 20))).status).toBe(200);
    const r = await call(leadBulk.POST, { token: admin.token, body: { action: 'tag_add', ids: [lead1.id], tagId: ids[20] } });
    expect(r.json.failed[0].code).toBe('VALIDATION_ERROR');
    await prisma.tag.createMany({ data: Array.from({ length: 200 - 21 }, (_, i) => ({ organizationId: admin.org.id, name: `批量${i}`, nameKey: `批量${i}` })) });
    const over = await call(tags.POST, { token: admin.token, body: { name: '第201个' } });
    expect(over.status).toBe(400);
    expect(over.json.error.details.name).toEqual(['limit']);
  });

  it.each([
    [{ name: '' }],
    [{ name: '   ' }],
    [{ name: 'x'.repeat(31) }],
    [{ name: '<b>' }],
    [{ name: 'a,b' }],
    [{ name: '正常', color: 'black' }],
    [{ name: '正常', organizationId: '00000000-0000-4000-8000-000000000000' }],
    [{ name: '正常', nameKey: 'hack' }],
  ])('非法标签 %j → 400 / invalid tag input', async (body) => {
    expect((await call(tags.POST, { token: admin.token, body })).status).toBe(400);
  });

  it('非法打标签与筛选参数 → 400 / invalid tagging and filter input', async () => {
    expect((await put(admin, lead1.id, ['not-a-uuid'])).status).toBe(400);
    expect((await call(leadTags.PUT, { token: admin.token, method: 'PUT', params: { id: lead1.id }, body: { tagIds: [], extra: 1 } })).status).toBe(400);
    expect((await call(leads.GET, { token: admin.token, query: { tagId: 'x' } })).status).toBe(400);
    expect((await call(leadBulk.POST, { token: admin.token, body: { action: 'tag_add', ids: [lead1.id] } })).status).toBe(400);
  });

  it('数据库约束：name_key 一致、颜色预设、跨组织关联被复合外键拒绝 / DB constraints', async () => {
    await expect(prisma.tag.create({ data: { organizationId: admin.org.id, name: 'Abc', nameKey: 'ABC' } })).rejects.toThrow();
    await expect(prisma.tag.create({ data: { organizationId: admin.org.id, name: 'x', nameKey: 'x', color: 'black' } })).rejects.toThrow();
    const other = await createTenant('B', 'ADMIN');
    await expect(prisma.leadTag.create({ data: { organizationId: other.org.id, leadId: lead1.id, tagId: tag.id } })).rejects.toThrow();
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(tags.GET)).status).toBe(401);
    expect((await call(leadTags.PUT, { method: 'PUT', params: { id: lead1.id }, body: { tagIds: [] } })).status).toBe(401);
  });
});

describe('tags R2 CORS', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 PUT（演示前端在另一域名）/ CORS preflight allows PUT', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await leadTags.OPTIONS(new Request('http://localhost/api/leads/x/tags', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});
