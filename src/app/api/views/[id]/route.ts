/**
 * PATCH/DELETE /api/views/:id — 修改、删除视图 / update or delete a view.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteView, updateView, viewUpdateSchema } from '@/server/modules/views';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateView(ctx, await routeId(route), await parseBody(req, viewUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteView(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
