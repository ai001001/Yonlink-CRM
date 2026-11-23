/**
 * GET /api/portal/tickets/:id — 自己的工单详情（只含公开评论）。
 * Own ticket detail (public comments only).
 */
import { preflight, routeId } from '@/server/http';
import { getMyTicket } from '@/server/modules/portal';
import { portalRoute } from '@/server/portal-auth';

export const GET = portalRoute(async (_req, ctx, route) => Response.json(await getMyTicket(ctx, await routeId(route))));
export const OPTIONS = preflight;
