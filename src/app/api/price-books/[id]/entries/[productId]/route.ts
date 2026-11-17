/**
 * DELETE /api/price-books/:id/entries/:productId — 移除产品价格 / remove a product's list price.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { removeEntry } from '@/server/modules/price-books';

export const DELETE = authedRoute(async (_req, ctx, route) => {
  await removeEntry(ctx, await routeId(route), await routeId(route, 'productId'));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
