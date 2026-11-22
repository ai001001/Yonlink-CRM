/**
 * PATCH/DELETE /api/blueprints/:id — 修改与删除流程蓝图（需 blueprint.manage）。
 * Update and delete a blueprint (blueprint.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { blueprintUpdateSchema, deleteBlueprint, updateBlueprint } from '@/server/modules/blueprints';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateBlueprint(ctx, await routeId(route), await parseBody(req, blueprintUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteBlueprint(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
