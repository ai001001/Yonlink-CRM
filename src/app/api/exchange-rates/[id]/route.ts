/**
 * DELETE /api/exchange-rates/:id — 删除一条汇率（管理员）/ delete a rate (admins).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { deleteRate } from '@/server/modules/exchange-rates';

export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteRate(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
