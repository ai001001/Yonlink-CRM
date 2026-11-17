/**
 * GET/PATCH/DELETE /api/price-books/:id — 价格表详情、修改、删除（清除客户上的指定）/ detail, update, delete (clears accounts).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deletePriceBook, getPriceBook, priceBookUpdateSchema, updatePriceBook } from '@/server/modules/price-books';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getPriceBook(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updatePriceBook(ctx, await routeId(route), await parseBody(req, priceBookUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deletePriceBook(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
