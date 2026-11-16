/**
 * 知识库 第二轮：集成测试（销售可写草稿、只能改删自己的草稿、不能发布或改已发布文章、看不到他人草稿；只读只能读已发布；
 * 经理可管理全部；工单关联遵循工单权限，文章详情只列可见工单；跨组织隔离；并发修改 409、并发关联只成功一次、
 * 并发浏览计数准确；未登录；跨域预检）。
 * Knowledge base round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as articleItem from '@/app/api/kb/articles/[id]/route';
import * as articles from '@/app/api/kb/articles/route';
import * as ticketArticleItem from '@/app/api/tickets/[id]/articles/[articleId]/route';
import * as ticketArticles from '@/app/api/tickets/[id]/articles/route';
import * as tickets from '@/app/api/tickets/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let published: { id: string };
const create = (who: Who, body: object = {}) => call(articles.POST, { token: who.token, body: { title: '文章', body: '正文', ...body } });
const patch = (who: Who, id: string, body: object) => call(articleItem.PATCH, { token: who.token, params: { id }, body, method: 'PATCH' });
const del = (who: Who, id: string) => call(articleItem.DELETE, { token: who.token, params: { id }, method: 'DELETE' });
const get = (who: Who, id: string, view = false) => call(articleItem.GET, { token: who.token, params: { id }, query: view ? { view: '1' } : {} });
const link = (who: Who, ticketId: string, articleId: string) => call(ticketArticles.POST, { token: who.token, params: { id: ticketId }, body: { articleId } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  published = (await create(manager, { title: '已发布', status: 'PUBLISHED' })).json;
});

describe('kb R2 permissions', () => {
  it('销售：写草稿、改删自己的草稿；不能发布、不能改已发布、看不到他人草稿 / sales', async () => {
    const mine = (await create(sales1, { title: '我的草稿' })).json;
    expect((await create(sales1, { status: 'PUBLISHED' })).status).toBe(403);
    expect((await patch(sales1, mine.id, { body: '改正文' })).json.body).toBe('改正文');
    const r = await patch(sales1, mine.id, { status: 'PUBLISHED' });
    expect(r.status).toBe(403);
    expect(r.json.error.details).toEqual({ permission: ['kb.manage'] });
    // 他人草稿不可见 / another rep's draft is invisible
    expect((await get(sales2, mine.id)).status).toBe(404);
    expect((await patch(sales2, mine.id, { title: 'x' })).status).toBe(404);
    expect((await call(articles.GET, { token: sales2.token, query: { status: 'DRAFT' } })).json.total).toBe(0);
    // 已发布文章：可读不可改、不可删 / published: readable, not editable or deletable
    expect((await get(sales1, published.id)).json.editable).toBe(false);
    expect((await patch(sales1, published.id, { title: 'x' })).json.error.details).toEqual({ article: ['not_editable'] });
    expect((await del(sales1, published.id)).status).toBe(403);
    // 自己的草稿发布后，作者也不能再改 / once published, the author can no longer edit it
    await patch(manager, mine.id, { status: 'PUBLISHED' });
    expect((await patch(sales1, mine.id, { title: 'x' })).status).toBe(403);
    const another = (await create(sales1, { title: '可删草稿' })).json;
    expect((await del(sales1, another.id)).status).toBe(204);
  });

  it('只读只能读已发布；经理可管理全部 / readonly and manager', async () => {
    const draft = (await create(sales1, { title: '销售草稿' })).json;
    expect((await create(viewer)).status).toBe(403);
    expect((await get(viewer, published.id)).status).toBe(200);
    expect((await get(viewer, draft.id)).status).toBe(404);
    expect((await call(articles.GET, { token: viewer.token })).json.items.map((x: { title: string }) => x.title)).toEqual(['已发布']);
    // 经理：看得到草稿，可修改、发布、删除任何文章 / managers see drafts and manage everything
    expect((await get(manager, draft.id)).json.editable).toBe(true);
    expect((await patch(manager, draft.id, { status: 'PUBLISHED', title: '经理改过' })).json).toMatchObject({ status: 'PUBLISHED', title: '经理改过' });
    expect((await del(manager, draft.id)).status).toBe(204);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'article.delete' } })).actorId).toBe(manager.user.id);
  });

  it('工单关联遵循工单权限；文章详情只列可见工单 / links follow ticket rights', async () => {
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    const t1 = (await call(tickets.POST, { token: admin.token, body: { subject: '销售1工单', accountId: acc.id, ownerId: sales1.user.id } })).json;
    const t2 = (await call(tickets.POST, { token: admin.token, body: { subject: '销售2工单', accountId: acc.id, ownerId: sales2.user.id } })).json;
    expect((await link(sales1, t1.id, published.id)).status).toBe(201);
    expect((await link(sales1, t2.id, published.id)).status).toBe(404);
    expect((await link(viewer, t1.id, published.id)).status).toBe(403);
    await link(sales2, t2.id, published.id);
    // 销售只看到自己工单的引用；经理看到全部 / reps see their own tickets only
    expect((await get(sales1, published.id)).json.tickets.map((x: { subject: string }) => x.subject)).toEqual(['销售1工单']);
    expect((await get(manager, published.id)).json.tickets).toHaveLength(2);
    expect((await call(ticketArticles.GET, { token: sales1.token, params: { id: t2.id } })).status).toBe(404);
    expect((await call(ticketArticleItem.DELETE, { token: viewer.token, params: { id: t1.id, articleId: published.id }, method: 'DELETE' })).status).toBe(403);
    expect((await call(ticketArticleItem.DELETE, { token: sales1.token, params: { id: t2.id, articleId: published.id }, method: 'DELETE' })).status).toBe(404);
    expect(await prisma.ticketArticle.count()).toBe(2);
  });

  it('跨组织隔离 / cross-tenant isolation', async () => {
    expect((await get(other, published.id)).status).toBe(404);
    expect((await patch(other, published.id, { title: 'x' })).status).toBe(404);
    expect((await del(other, published.id)).status).toBe(404);
    expect((await call(articles.GET, { token: other.token })).json.total).toBe(0);
    const oAcc = (await call(accounts.POST, { token: other.token, body: { name: '乙方' } })).json;
    const oTk = (await call(tickets.POST, { token: other.token, body: { subject: '乙方工单', accountId: oAcc.id } })).json;
    expect((await link(other, oTk.id, published.id)).json.error.details).toEqual({ articleId: ['not_found'] });
    expect((await call(articles.GET)).status).toBe(401);
    expect((await call(articles.POST, { body: { title: 'x', body: 'y' } })).status).toBe(401);
  });
});

describe('kb R2 concurrency & cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('并发修改 409、并发关联只成功一次、并发浏览计数准确 / concurrency', async () => {
    const rs = await Promise.all([patch(manager, published.id, { title: '甲' }), patch(admin, published.id, { title: '乙' }), patch(manager, published.id, { category: '丙' })]);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.json.error.details).toEqual({ article: ['stale'] });
    expect(await prisma.auditLog.count({ where: { action: 'article.update', entityId: published.id } })).toBe(ok);
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    const tk = (await call(tickets.POST, { token: admin.token, body: { subject: '工单', accountId: acc.id } })).json;
    const links = await Promise.all(Array.from({ length: 4 }, () => link(admin, tk.id, published.id)));
    expect(links.filter((r) => r.status === 201)).toHaveLength(1);
    expect(links.filter((r) => r.status === 409)).toHaveLength(3);
    await Promise.all(Array.from({ length: 10 }, () => get(viewer, published.id, true)));
    expect((await prisma.kbArticle.findUniqueOrThrow({ where: { id: published.id } })).viewCount).toBe(10);
  });

  it('跨域预检 / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    for (const route of [articles, articleItem, ticketArticles, ticketArticleItem]) {
      const res = await route.OPTIONS(new Request('http://localhost/api/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    }
  });
});
