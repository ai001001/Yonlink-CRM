/**
 * POST /api/quotes/:id/approval/recall — 撤回待审批（提交人或审批人）。
 * Recall a pending request (the submitter or an approver).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { recallApproval } from '@/server/modules/approvals';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await recallApproval(ctx, await routeId(route))));
export const OPTIONS = preflight;
