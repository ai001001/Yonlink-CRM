/**
 * GET /api/quotes/:id/approval — 报价单审批历史（最新在前）。
 * A quote's approval history, newest first.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { approvalHistory } from '@/server/modules/approvals';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await approvalHistory(ctx, await routeId(route))));
export const OPTIONS = preflight;
