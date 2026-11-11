/**
 * POST /api/deals/bulk — 商机批量操作（逐条执行，返回成功与失败明细）/ bulk actions on deals.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { bulkDeals, dealBulkSchema } from '@/server/modules/bulk';

export const POST = authedRoute(async (req, ctx) => Response.json(await bulkDeals(ctx, await parseBody(req, dealBulkSchema))));
export const OPTIONS = preflight;
