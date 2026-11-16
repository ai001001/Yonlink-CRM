/**
 * GET/PATCH/DELETE /api/kb/articles/:id — 文章详情（?view=1 计入浏览）、修改（含发布、归档）、删除 /
 * article detail (?view=1 counts a view), update (publish and archive included) and delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { articleUpdateSchema, deleteArticle, getArticle, updateArticle } from '@/server/modules/kb-articles';

export const GET = authedRoute(async (req, ctx, route) => Response.json(await getArticle(ctx, await routeId(route), new URL(req.url).searchParams.get('view') === '1')));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateArticle(ctx, await routeId(route), await parseBody(req, articleUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteArticle(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
