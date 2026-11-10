/**
 * GET/PATCH/DELETE /api/deals/:id — 商机详情、编辑、删除 / deal detail, update, delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { dealUpdateSchema, deleteDeal, getDeal, updateDeal } from '@/server/modules/deals';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getDeal(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) =>
  Response.json(await updateDeal(ctx, await routeId(route), await parseBody(req, dealUpdateSchema))),
);
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteDeal(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
