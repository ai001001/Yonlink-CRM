/**
 * GET /api/approvals — 审批列表：scope=pending 待审批（需 quote.approve），scope=mine 我提交的。
 * Approval lists: pending (quote.approve) or mine.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { approvalListSchema, listApprovals } from '@/server/modules/approvals';

export const GET = authedRoute(async (req, ctx) => Response.json(await listApprovals(ctx, parseQuery(req, approvalListSchema))));
export const OPTIONS = preflight;
