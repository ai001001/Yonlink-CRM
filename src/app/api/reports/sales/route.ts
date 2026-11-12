/**
 * GET /api/reports/sales — 销售报表（按币种、时间段、负责人）/ sales report by currency, period and owner.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { reportQuerySchema, salesReport } from '@/server/modules/reports';

export const GET = authedRoute(async (req, ctx) => Response.json(await salesReport(ctx, parseQuery(req, reportQuerySchema))));
export const OPTIONS = preflight;
