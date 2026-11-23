/**
 * POST /api/portal/tickets/:id/comments — 在门户中回复工单（已解决或等待客户的工单重新打开）。
 * Reply to a ticket from the portal (resolved or waiting tickets reopen).
 */
import { parseBody, preflight, routeId } from '@/server/http';
import { addMyComment, portalCommentSchema } from '@/server/modules/portal';
import { portalRoute } from '@/server/portal-auth';

export const POST = portalRoute(async (req, ctx, route) => Response.json(await addMyComment(ctx, await routeId(route), await parseBody(req, portalCommentSchema)), { status: 201 }));
export const OPTIONS = preflight;
