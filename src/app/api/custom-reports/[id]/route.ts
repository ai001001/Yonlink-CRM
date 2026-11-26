/**
 * GET/PUT/DELETE /api/custom-reports/:id — 报表定义、修改（创建者）与删除。
 * A report definition, update (creator) and delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteReport, getReport, reportUpdateSchema, updateReport } from '@/server/modules/custom-reports';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getReport(ctx, await routeId(route))));
export const PUT = authedRoute(async (req, ctx, route) => Response.json(await updateReport(ctx, await routeId(route), await parseBody(req, reportUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteReport(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
