/**
 * GET/PATCH/DELETE /api/activities/:id — 跟进记录详情、编辑（含完成状态）、删除。
 * Activity detail, update (including completion) and delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { activityUpdateSchema, deleteActivity, getActivity, updateActivity } from '@/server/modules/activities';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getActivity(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) =>
  Response.json(await updateActivity(ctx, await routeId(route), await parseBody(req, activityUpdateSchema))),
);
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteActivity(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
