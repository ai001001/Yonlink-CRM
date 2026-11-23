/**
 * PATCH/DELETE /api/cadences/:id — 修改与删除销售节奏（需 cadence.manage）。
 * Update and delete a cadence (cadence.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { cadenceUpdateSchema, deleteCadence, updateCadence } from '@/server/modules/cadences';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateCadence(ctx, await routeId(route), await parseBody(req, cadenceUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteCadence(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
