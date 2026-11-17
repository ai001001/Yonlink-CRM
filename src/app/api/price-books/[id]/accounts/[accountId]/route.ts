/**
 * DELETE /api/price-books/:id/accounts/:accountId — 取消客户的默认价格表 / remove the book as an account's default.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { unassignAccount } from '@/server/modules/price-books';

export const DELETE = authedRoute(async (_req, ctx, route) => {
  await unassignAccount(ctx, await routeId(route), await routeId(route, 'accountId'));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
