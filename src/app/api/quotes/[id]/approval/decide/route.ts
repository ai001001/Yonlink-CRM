/**
 * POST /api/quotes/:id/approval/decide — 批准或驳回（需 quote.approve，不能审批自己提交的）。
 * Approve or reject (quote.approve; not your own submission).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { approvalDecisionSchema, decideApproval } from '@/server/modules/approvals';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await decideApproval(ctx, await routeId(route), await parseBody(req, approvalDecisionSchema))));
export const OPTIONS = preflight;
