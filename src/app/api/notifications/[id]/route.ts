/**
 * DELETE /api/notifications/:id — 删除一条自己的通知 / delete one of my notifications.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { deleteNotification } from '@/server/modules/notifications';

export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteNotification(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
