/**
 * POST /api/accounts/bulk — 客户批量操作（逐条执行，返回成功与失败明细）/ bulk actions on accounts.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { bulkAccounts, accountBulkSchema } from '@/server/modules/bulk';

export const POST = authedRoute(async (req, ctx) => Response.json(await bulkAccounts(ctx, await parseBody(req, accountBulkSchema))));
export const OPTIONS = preflight;
