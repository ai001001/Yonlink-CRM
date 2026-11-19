/**
 * POST /api/quotes/:id/approval/submit — 提交审批（草稿且需要审批）。
 * Submit a draft that needs approval.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { approvalSubmitSchema, submitApproval } from '@/server/modules/approvals';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await submitApproval(ctx, await routeId(route), await parseBody(req, approvalSubmitSchema))));
export const OPTIONS = preflight;
