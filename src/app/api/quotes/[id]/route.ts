/**
 * GET/PATCH/DELETE /api/quotes/:id — 报价单详情、修改草稿、删除草稿 / quote detail, update and delete drafts.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteQuote, getQuote, quoteUpdateSchema, updateQuote } from '@/server/modules/quotes';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getQuote(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateQuote(ctx, await routeId(route), await parseBody(req, quoteUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteQuote(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
