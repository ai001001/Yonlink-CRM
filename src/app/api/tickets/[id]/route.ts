/**
 * GET/PATCH/DELETE /api/tickets/:id — 工单详情、修改（含状态流转与改派）、删除 / ticket detail, update (status and reassignment), delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteTicket, getTicket, ticketUpdateSchema, updateTicket } from '@/server/modules/tickets';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getTicket(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateTicket(ctx, await routeId(route), await parseBody(req, ticketUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteTicket(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
