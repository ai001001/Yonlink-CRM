/**
 * 知识库（对标 Zoho Solutions）：文章与工单关联。
 * - 可见：已发布、已归档的文章所有登录用户可读；草稿只有作者本人与有 kb.manage 的用户（管理员、经理）可见。
 * - 编辑：有 record.create 的用户可新建草稿，作者可修改、删除自己的草稿；发布、归档、退回草稿、修改已发布文章、
 *   删除任何文章需 kb.manage。修改带乐观并发（基于 updatedAt），并发修改返回 409。
 * - 正文为纯文本（前端按文本显示，不渲染 HTML）；审计中正文只记“已修改”。
 * - 浏览数：打开已发布文章时原子加一（不改变 updatedAt，不影响并发判断）。
 * - 工单关联：能编辑工单的用户可把已发布文章关联到工单（参考或解决依据），写在工单审计中；随工单或文章删除。
 * Knowledge base (cf. Zoho Solutions): articles and their links to tickets. Published and archived articles are
 * readable by everyone; drafts only by their author and kb.manage holders. Users with record.create write drafts and
 * authors edit or delete their own drafts; publishing, archiving, unpublishing, editing published articles and
 * deleting any article need kb.manage. Edits use optimistic concurrency (409 when stale). Bodies are plain text and
 * audited as changed only. Opening a published article increments its view count atomically without touching
 * updatedAt. Ticket editors may link published articles to tickets (audited on the ticket); links go with either side.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { KbArticleStatus } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, can, requirePermission, visible } from '../permissions';
import { containsText, listQuery, type Page } from '../validation';

const category = z
  .string()
  .trim()
  .max(50)
  .nullish()
  .transform((v) => v || null);

const fields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(50_000),
  category,
  status: z.enum(KbArticleStatus).default(KbArticleStatus.DRAFT),
};

/** 新建文章 / Create an article */
export const articleCreateSchema = z.strictObject(fields);
/** 修改文章 / Update an article */
export const articleUpdateSchema = z
  .strictObject({ ...fields, status: z.enum(KbArticleStatus) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'No changes');
/** 列表查询 / List query */
export const articleListSchema = listQuery.extend({
  status: z.enum(KbArticleStatus).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  /** 只看我写的 / mine only */
  mine: z.enum(['true']).optional(),
});
/** 关联文章到工单 / Link an article to a ticket */
export const ticketArticleSchema = z.strictObject({ articleId: z.uuid() });

/** 摘要长度 / excerpt length */
const EXCERPT = 160;

const include = { author: { select: { id: true, name: true } }, _count: { select: { tickets: true } } } satisfies Prisma.KbArticleInclude;

/**
 * 当前用户可见的文章条件。
 * Articles visible to the user.
 */
function visibleArticles(ctx: AuthContext): Prisma.KbArticleWhereInput {
  if (can(ctx, 'kb.manage')) return { organizationId: ctx.organizationId };
  return { organizationId: ctx.organizationId, OR: [{ status: { not: KbArticleStatus.DRAFT } }, { authorId: ctx.userId }] };
}

/**
 * 当前用户能否修改该文章：知识库管理员可改任何文章；作者只能改自己的草稿。
 * Whether the user may edit the article: KB managers any; authors their own drafts only.
 */
export function canEditArticle(ctx: AuthContext, a: { authorId: string; status: KbArticleStatus }): boolean {
  return can(ctx, 'kb.manage') || (a.authorId === ctx.userId && a.status === KbArticleStatus.DRAFT && can(ctx, 'record.create'));
}

/** 只有知识库管理员能改变发布状态 / only KB managers change the publication state */
function assertStatusChange(ctx: AuthContext, from: KbArticleStatus | null, to: KbArticleStatus) {
  if (to !== (from ?? KbArticleStatus.DRAFT) && !can(ctx, 'kb.manage')) {
    throw new ApiError(403, 'FORBIDDEN', 'Only knowledge-base managers can change the status', { permission: ['kb.manage'] });
  }
}

/**
 * 分页搜索文章（标题、正文、分类），最近更新在前；列表返回摘要而不是全文，并附本组织可见的分类列表。
 * Search articles (title, body, category), most recently updated first; returns excerpts and the visible categories.
 */
export async function listArticles(ctx: AuthContext, query: z.infer<typeof articleListSchema>): Promise<Page<unknown> & { categories: string[] }> {
  const and: Prisma.KbArticleWhereInput[] = [visibleArticles(ctx)];
  if (query.status) and.push({ status: query.status });
  if (query.category) and.push({ category: query.category });
  if (query.mine) and.push({ authorId: ctx.userId });
  if (query.q) {
    const c = containsText(query.q);
    and.push({ OR: [{ title: c }, { body: c }, { category: c }] });
  }
  const where = { AND: and };
  const [rows, total, cats] = await prisma.$transaction([
    prisma.kbArticle.findMany({ where, include, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.kbArticle.count({ where }),
    prisma.kbArticle.findMany({ where: { ...visibleArticles(ctx), category: { not: null } }, select: { category: true }, distinct: ['category'], orderBy: { category: 'asc' } }),
  ]);
  const items = rows.map(({ body, ...a }) => ({ ...a, excerpt: body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body, editable: canEditArticle(ctx, a) }));
  return { items, total, page: query.page, pageSize: query.pageSize, categories: cats.map((c) => c.category!) };
}

/**
 * 读取可见文章；不可见 404。
 * Load a visible article; 404 otherwise.
 */
async function requireArticle(ctx: AuthContext, id: string) {
  const article = await prisma.kbArticle.findFirst({ where: { AND: [{ id }, visibleArticles(ctx)] }, include });
  if (!article) throw notFound();
  return article;
}

/**
 * 文章详情（含引用它的、当前用户可见的工单）；view=true 且已发布时浏览数加一。
 * Article detail with the linked tickets the user can see; increments the view count for published articles when view=true.
 */
export async function getArticle(ctx: AuthContext, id: string, view = false) {
  const article = await requireArticle(ctx, id);
  if (view && article.status === KbArticleStatus.PUBLISHED) {
    // 原子加一且不改变 updatedAt / atomic increment that leaves updatedAt alone
    await prisma.$executeRaw`UPDATE kb_articles SET view_count = view_count + 1 WHERE organization_id = ${ctx.organizationId}::uuid AND id = ${id}::uuid`;
    article.viewCount += 1;
  }
  const links = await prisma.ticketArticle.findMany({
    where: { organizationId: ctx.organizationId, articleId: id, ticket: visible(ctx) },
    select: { ticket: { select: { id: true, ticketNumber: true, subject: true, status: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return { ...article, editable: canEditArticle(ctx, article), tickets: links.map((l) => l.ticket) };
}

/**
 * 新建文章（默认草稿；直接发布需 kb.manage）。
 * Create an article (draft by default; publishing directly needs kb.manage).
 */
export async function createArticle(ctx: AuthContext, input: z.infer<typeof articleCreateSchema>) {
  requirePermission(ctx, 'record.create');
  assertStatusChange(ctx, null, input.status);
  return prisma.$transaction(async (tx) => {
    const article = await tx.kbArticle.create({
      data: { ...input, organizationId: ctx.organizationId, authorId: ctx.userId, publishedAt: input.status === KbArticleStatus.DRAFT ? null : new Date() },
      include,
    });
    await audit(tx, { ...by(ctx), action: 'article.create', entityType: 'article', entityId: article.id, changes: { after: snapshot('article', article) } });
    return { ...article, editable: canEditArticle(ctx, article), tickets: [] };
  });
}

/**
 * 修改文章（含发布、归档、退回草稿）；乐观并发。
 * Update an article (publishing, archiving and unpublishing included); optimistic concurrency.
 */
export async function updateArticle(ctx: AuthContext, id: string, input: z.infer<typeof articleUpdateSchema>) {
  const current = await requireArticle(ctx, id);
  if (!canEditArticle(ctx, current)) throw new ApiError(403, 'FORBIDDEN', 'Cannot edit this article', { article: ['not_editable'] });
  const status = input.status ?? current.status;
  assertStatusChange(ctx, current.status, status);
  // 首次发布记录发布时间；退回草稿清空 / record the first publication; unpublishing clears it
  const publishedAt = status === KbArticleStatus.DRAFT ? null : (current.publishedAt ?? new Date());
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.kbArticle.updateMany({ where: { id, organizationId: ctx.organizationId, updatedAt: current.updatedAt }, data: { ...input, publishedAt } });
    if (!count) throw new ApiError(409, 'CONFLICT', 'Article was changed by someone else', { article: ['stale'] });
    const article = await tx.kbArticle.findUniqueOrThrow({ where: { id }, include });
    const changed = diff('article', current, article);
    if (Object.keys(changed).length) await audit(tx, { ...by(ctx), action: 'article.update', entityType: 'article', entityId: id, changes: { fields: changed } });
    return getArticleIn(tx, ctx, article);
  });
}

/**
 * 在事务内补充详情字段（编辑权限与可见工单）。
 * Attach detail fields inside the transaction (edit right and visible tickets).
 */
async function getArticleIn(tx: Prisma.TransactionClient, ctx: AuthContext, article: Prisma.KbArticleGetPayload<{ include: typeof include }>) {
  const links = await tx.ticketArticle.findMany({
    where: { organizationId: ctx.organizationId, articleId: article.id, ticket: visible(ctx) },
    select: { ticket: { select: { id: true, ticketNumber: true, subject: true, status: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return { ...article, editable: canEditArticle(ctx, article), tickets: links.map((l) => l.ticket) };
}

/**
 * 删除文章（知识库管理员；或作者删除自己的草稿）；与工单的关联随之删除。
 * Delete an article (KB managers; or authors their own drafts); ticket links go with it.
 */
export async function deleteArticle(ctx: AuthContext, id: string): Promise<void> {
  const current = await requireArticle(ctx, id);
  if (!canEditArticle(ctx, current)) throw new ApiError(403, 'FORBIDDEN', 'Cannot delete this article', { article: ['not_editable'] });
  await prisma.$transaction(async (tx) => {
    const links = await tx.ticketArticle.count({ where: { organizationId: ctx.organizationId, articleId: id } });
    const { count } = await tx.kbArticle.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (!count) throw notFound();
    await audit(tx, { ...by(ctx), action: 'article.delete', entityType: 'article', entityId: id, changes: { before: snapshot('article', current), unlinkedTickets: links } });
  });
}

/**
 * 读取可见工单（关联操作用）。
 * Load a visible ticket (for linking).
 */
async function requireTicket(ctx: AuthContext, ticketId: string) {
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, ...visible(ctx) }, select: { id: true, ownerId: true } });
  if (!ticket) throw notFound();
  return ticket;
}

/**
 * 工单关联的文章（草稿不会被关联；已归档的仍列出并标明状态）。
 * Articles linked to a ticket (drafts cannot be linked; archived ones are listed with their status).
 */
export async function listTicketArticles(ctx: AuthContext, ticketId: string) {
  await requireTicket(ctx, ticketId);
  const rows = await prisma.ticketArticle.findMany({
    where: { organizationId: ctx.organizationId, ticketId },
    select: { createdAt: true, linkedBy: { select: { id: true, name: true } }, article: { select: { id: true, title: true, category: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return { items: rows.map((r) => ({ ...r.article, linkedAt: r.createdAt, linkedBy: r.linkedBy })) };
}

/**
 * 把已发布文章关联到工单（需能编辑工单；重复关联 409）。
 * Link a published article to a ticket (ticket edit rights; 409 when already linked).
 */
export async function linkArticle(ctx: AuthContext, ticketId: string, input: z.infer<typeof ticketArticleSchema>) {
  assertCanUpdate(ctx, await requireTicket(ctx, ticketId));
  const article = await prisma.kbArticle.findFirst({ where: { id: input.articleId, organizationId: ctx.organizationId }, select: { id: true, title: true, status: true } });
  if (!article) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid article', { articleId: ['not_found'] });
  if (article.status !== KbArticleStatus.PUBLISHED) throw new ApiError(400, 'VALIDATION_ERROR', 'Only published articles can be linked', { articleId: ['not_published'] });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.ticketArticle.create({ data: { organizationId: ctx.organizationId, ticketId, articleId: article.id, linkedById: ctx.userId } });
      await audit(tx, { ...by(ctx), action: 'ticket.link_article', entityType: 'ticket', entityId: ticketId, changes: { articleId: article.id, article: article.title } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Article already linked', { articleId: ['duplicate'] });
    throw err;
  }
  return listTicketArticles(ctx, ticketId);
}

/**
 * 取消工单与文章的关联。
 * Unlink an article from a ticket.
 */
export async function unlinkArticle(ctx: AuthContext, ticketId: string, articleId: string): Promise<void> {
  assertCanUpdate(ctx, await requireTicket(ctx, ticketId));
  await prisma.$transaction(async (tx) => {
    const link = await tx.ticketArticle.findFirst({ where: { organizationId: ctx.organizationId, ticketId, articleId }, select: { article: { select: { title: true } } } });
    if (!link) throw notFound();
    await tx.ticketArticle.deleteMany({ where: { organizationId: ctx.organizationId, ticketId, articleId } });
    await audit(tx, { ...by(ctx), action: 'ticket.unlink_article', entityType: 'ticket', entityId: ticketId, changes: { articleId, article: link.article.title } });
  });
}
