/**
 * POST /api/leads/bulk — 线索批量操作（逐条执行，返回成功与失败明细）/ bulk actions on leads.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { bulkLeads, leadBulkSchema } from '@/server/modules/bulk';

export const POST = authedRoute(async (req, ctx) => Response.json(await bulkLeads(ctx, await parseBody(req, leadBulkSchema))));
export const OPTIONS = preflight;
