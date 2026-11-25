/**
 * GET/PATCH/DELETE /api/custom-modules/:id — 模块详情（含字段）、修改（名称、说明、启停）与删除（有记录时 409）。
 * Module detail (with fields), update (name, description, active) and delete (409 while it has records).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteModule, getModule, moduleUpdateSchema, updateModule } from '@/server/modules/custom-modules';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getModule(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateModule(ctx, await routeId(route), await parseBody(req, moduleUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteModule(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
