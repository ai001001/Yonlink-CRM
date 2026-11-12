/**
 * DELETE /api/recycle-bin/:id — 彻底删除回收站条目（需彻底删除权限）/ permanently delete an entry (purge permission).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { purgeItem } from '@/server/modules/recycle-bin';

export const DELETE = authedRoute(async (_req, ctx, route) => {
  await purgeItem(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
