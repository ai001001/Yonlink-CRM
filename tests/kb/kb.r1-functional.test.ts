/**
 * 知识库 第一轮：功能测试（新建草稿、去空白、校验、审计正文脱敏；发布记录发布时间、归档保留、退回草稿清空；
 * 列表摘要、分类列表、按状态 / 分类 / 关键词 / 我写的筛选；浏览数只在打开已发布文章时增加且不影响并发判断；
 * 工单关联：只能关联已发布文章、重复 409、取消关联、审计；删除文章解除关联；演示数据）。
 * Knowledge base round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_KB_ARTICLES, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as articleItem from '@/app/api/kb/articles/[id]/route';
import * as articles from '@/app/api/kb/articles/route';
import * as ticketArticleItem from '@/app/api/tickets/[id]/articles/[articleId]/route';
import * as ticketArticles from '@/app/api/tickets/[id]/articles/route';
import * as tickets from '@/app/api/tickets/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const create = (body: object) => call(articles.POST, { token: a.token, body: { title: '标题', body: '正文', ...body } });
const patch = (id: string, body: object) => call(articleItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });
const get = (id: string, view = false) => call(articleItem.GET, { token: a.token, params: { id }, query: view ? { view: '1' } : {} });
const titles = async (query: Record<string, string> = {}) => (await call(articles.GET, { token: a.token, query })).json.items.map((x: { title: string }) => x.title).sort();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('kb R1 articles', () => {
  it('新建草稿、校验、审计正文脱敏 / create draft, validation, audit', async () => {
    const r = await create({ title: '  异响排查  ', body: '机密步骤\n第二行', category: ' 故障排查 ' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ title: '异响排查', body: '机密步骤\n第二行', category: '故障排查', status: 'DRAFT', publishedAt: null, viewCount: 0, author: { id: a.user.id }, editable: true, tickets: [] });
    expect((await create({ category: '  ' })).json.category).toBeNull();
    for (const body of [{ title: ' ' }, { body: '   ' }, { title: 'x'.repeat(201) }, { body: 'x'.repeat(50_001) }, { category: 'x'.repeat(51) }, { status: 'LIVE' }, { authorId: a.user.id }, { viewCount: 9 }]) {
      expect((await create(body)).status).toBe(400);
    }
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'article.create', entityId: r.json.id } });
    expect(log.changes).toMatchObject({ after: { title: '异响排查', body: '[redacted]', category: '故障排查', status: 'DRAFT' } });
    expect(JSON.stringify(log.changes)).not.toContain('机密');
  });

  it('发布、归档、退回草稿与发布时间；修改审计 / publish, archive, unpublish', async () => {
    const d = (await create({})).json;
    const pub = (await patch(d.id, { status: 'PUBLISHED' })).json;
    expect(pub.status).toBe('PUBLISHED');
    expect(pub.publishedAt).not.toBeNull();
    const arc = (await patch(d.id, { status: 'ARCHIVED' })).json;
    expect(arc.publishedAt).toBe(pub.publishedAt);
    expect((await patch(d.id, { status: 'DRAFT' })).json.publishedAt).toBeNull();
    await patch(d.id, { body: '新的正文', title: '新标题' });
    const logs = await prisma.auditLog.findMany({ where: { action: 'article.update', entityId: d.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => (l.changes as { fields: Record<string, unknown> }).fields)).toEqual([
      { status: ['DRAFT', 'PUBLISHED'] },
      { status: ['PUBLISHED', 'ARCHIVED'] },
      { status: ['ARCHIVED', 'DRAFT'] },
      { title: ['标题', '新标题'], body: ['[redacted]', '[redacted]'] },
    ]);
    expect((await patch(d.id, {})).status).toBe(400);
    // 直接新建为已发布 / create as published directly
    expect((await create({ status: 'PUBLISHED' })).json.publishedAt).not.toBeNull();
  });

  it('列表摘要、分类、筛选与搜索 / list, excerpt, categories, filters', async () => {
    const long = 'A'.repeat(200);
    await create({ title: '长文', body: long, category: '安装', status: 'PUBLISHED' });
    await create({ title: '异响', body: '听诊步骤', category: '故障排查', status: 'PUBLISHED' });
    await create({ title: '草稿', body: '未完成' });
    await create({ title: '旧文', body: '停用', category: '安装', status: 'ARCHIVED' });
    const r = (await call(articles.GET, { token: a.token, query: { status: 'PUBLISHED' } })).json;
    expect(r.total).toBe(2);
    expect(r.categories).toEqual(['安装', '故障排查']);
    const longItem = r.items.find((x: { title: string }) => x.title === '长文');
    expect(longItem.excerpt).toBe(`${'A'.repeat(160)}…`);
    expect(longItem.body).toBeUndefined();
    expect(await titles()).toEqual(['异响', '旧文', '草稿', '长文'].sort());
    expect(await titles({ status: 'DRAFT' })).toEqual(['草稿']);
    expect(await titles({ category: '安装' })).toEqual(['旧文', '长文'].sort());
    expect(await titles({ q: '听诊' })).toEqual(['异响']);
    expect(await titles({ q: '故障' })).toEqual(['异响']);
    expect(await titles({ mine: 'true', status: 'ARCHIVED' })).toEqual(['旧文']);
    for (const query of [{ status: 'LIVE' }, { mine: 'yes' }, { category: '' }] as Record<string, string>[]) expect((await call(articles.GET, { token: a.token, query })).status).toBe(400);
  });

  it('浏览数：只在打开已发布文章时增加，不影响修改 / view count', async () => {
    const d = (await create({})).json;
    await get(d.id, true);
    expect((await get(d.id)).json.viewCount).toBe(0);
    await patch(d.id, { status: 'PUBLISHED' });
    const before = (await get(d.id)).json;
    await get(d.id, true);
    await get(d.id, true);
    const after = (await get(d.id)).json;
    expect(after.viewCount).toBe(2);
    // updatedAt 不变：基于旧版本的修改仍能保存 / updatedAt unchanged: an edit based on the earlier read still saves
    expect(after.updatedAt).toBe(before.updatedAt);
    expect((await patch(d.id, { title: '改' })).status).toBe(200);
  });
});

describe('kb R1 ticket links & demo', () => {
  it('工单关联：只能关联已发布、重复 409、取消、审计、删除文章解除关联 / links', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const tk = (await call(tickets.POST, { token: a.token, body: { subject: '异响', accountId: acc.id } })).json;
    const pub = (await create({ title: '已发布文章', status: 'PUBLISHED', category: '排查' })).json;
    const draft = (await create({ title: '草稿文章' })).json;
    const link = (articleId: string) => call(ticketArticles.POST, { token: a.token, params: { id: tk.id }, body: { articleId } });
    expect((await link(draft.id)).json.error.details).toEqual({ articleId: ['not_published'] });
    expect((await link('00000000-0000-4000-8000-000000000000')).json.error.details).toEqual({ articleId: ['not_found'] });
    const r = await link(pub.id);
    expect(r.status).toBe(201);
    expect(r.json.items).toMatchObject([{ id: pub.id, title: '已发布文章', category: '排查', status: 'PUBLISHED', linkedBy: { id: a.user.id } }]);
    expect((await link(pub.id)).json.error.details).toEqual({ articleId: ['duplicate'] });
    // 文章详情列出引用的工单，列表计数 / the article lists the ticket; the list counts it
    expect((await get(pub.id)).json.tickets).toEqual([{ id: tk.id, ticketNumber: tk.ticketNumber, subject: '异响', status: 'OPEN' }]);
    expect((await call(articles.GET, { token: a.token, query: { status: 'PUBLISHED' } })).json.items[0]._count.tickets).toBe(1);
    // 归档后仍保留关联并显示状态 / archiving keeps the link and shows the status
    await patch(pub.id, { status: 'ARCHIVED' });
    expect((await call(ticketArticles.GET, { token: a.token, params: { id: tk.id } })).json.items[0].status).toBe('ARCHIVED');
    expect((await call(ticketArticleItem.DELETE, { token: a.token, params: { id: tk.id, articleId: pub.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(ticketArticleItem.DELETE, { token: a.token, params: { id: tk.id, articleId: pub.id }, method: 'DELETE' })).status).toBe(404);
    const logs = await prisma.auditLog.findMany({ where: { entityId: tk.id, action: { in: ['ticket.link_article', 'ticket.unlink_article'] } }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => [l.action, (l.changes as { article: string }).article])).toEqual([
      ['ticket.link_article', '已发布文章'],
      ['ticket.unlink_article', '已发布文章'],
    ]);
    // 删除文章解除关联并记录数量 / deleting the article removes links and records how many
    await patch(pub.id, { status: 'PUBLISHED' });
    await link(pub.id);
    expect((await call(articleItem.DELETE, { token: a.token, params: { id: pub.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.ticketArticle.count()).toBe(0);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'article.delete' } })).changes).toMatchObject({ unlinkedTickets: 1, before: { title: '已发布文章', body: '[redacted]' } });
  });

  it('演示文章与关联 / demo articles', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.kbArticle.findMany({ where: { organizationId: org.id }, include: { tickets: { include: { ticket: { select: { subject: true, ownerId: true } } } } } });
    expect(rows.map((r) => r.title).sort()).toEqual(DEMO_KB_ARTICLES.map((x) => x.title).sort());
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['DRAFT', 'PUBLISHED', 'ARCHIVED']));
    for (const r of rows) {
      expect(r.status === 'DRAFT' ? r.publishedAt : r.publishedAt?.getTime()).toBe(r.status === 'DRAFT' ? null : r.createdAt.getTime());
      const plan = DEMO_KB_ARTICLES.find((x) => x.title === r.title)!;
      expect(r.tickets.map((l) => l.ticket.subject).sort()).toEqual([...plan.tickets].sort());
      for (const l of r.tickets) expect(l.linkedById).toBe(l.ticket.ownerId);
    }
  });
});
