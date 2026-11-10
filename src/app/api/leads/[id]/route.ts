/**
 * GET/PATCH/DELETE /api/leads/:id — 线索详情、编辑、删除 / lead detail, update, delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteLead, getLead, leadUpdateSchema, updateLead } from '@/server/modules/leads';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getLead(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) =>
  Response.json(await updateLead(ctx, await routeId(route), await parseBody(req, leadUpdateSchema))),
);
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteLead(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
