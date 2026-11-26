/**
 * GET /api/custom-reports/:id/run — 运行已保存的报表（按查看者的可见范围；明细可分页）。
 * Run a saved report (within the viewer's visibility; details are paged).
 */
import { authedRoute, parseQuery, preflight, routeId } from '@/server/http';
import { runQuerySchema, runReport } from '@/server/modules/custom-reports';

export const GET = authedRoute(async (req, ctx, route) => Response.json(await runReport(ctx, await routeId(route), parseQuery(req, runQuerySchema))));
export const OPTIONS = preflight;
