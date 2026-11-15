/**
 * PATCH/DELETE /api/deal-competitors/:id — 修改、删除商机竞争对手 / update or remove a deal competitor.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { competitorUpdateSchema, removeCompetitor, updateCompetitor } from '@/server/modules/deal-competitors';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateCompetitor(ctx, await routeId(route), await parseBody(req, competitorUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await removeCompetitor(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
