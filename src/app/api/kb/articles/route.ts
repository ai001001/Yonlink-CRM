/**
 * GET/POST /api/kb/articles — 知识库文章列表（摘要与分类）与新建 / knowledge-base article list (excerpts, categories) and create.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { articleCreateSchema, articleListSchema, createArticle, listArticles } from '@/server/modules/kb-articles';

export const GET = authedRoute(async (req, ctx) => Response.json(await listArticles(ctx, parseQuery(req, articleListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createArticle(ctx, await parseBody(req, articleCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
