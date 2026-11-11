/**
 * POST /api/activities/bulk — 跟进批量操作（逐条执行，返回成功与失败明细）/ bulk actions on activities.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { bulkActivities, activityBulkSchema } from '@/server/modules/bulk';

export const POST = authedRoute(async (req, ctx) => Response.json(await bulkActivities(ctx, await parseBody(req, activityBulkSchema))));
export const OPTIONS = preflight;
