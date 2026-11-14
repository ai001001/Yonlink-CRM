/**
 * GET /api/reports/receivables — 应收账款报表（按币种、负责人）/ accounts receivable report by currency and owner.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { receivablesQuerySchema, receivablesReport } from '@/server/modules/receivables';

export const GET = authedRoute(async (req, ctx) => Response.json(await receivablesReport(ctx, parseQuery(req, receivablesQuerySchema))));
export const OPTIONS = preflight;
