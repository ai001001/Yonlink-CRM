/**
 * GET/POST /api/portal/tickets — 自己的工单与在门户中新建工单。
 * Own tickets and raising a ticket from the portal.
 */
import { parseBody, preflight } from '@/server/http';
import { createMyTicket, listMyTickets, portalTicketSchema } from '@/server/modules/portal';
import { portalRoute } from '@/server/portal-auth';

export const GET = portalRoute(async (_req, ctx) => Response.json(await listMyTickets(ctx)));
export const POST = portalRoute(async (req, ctx) => Response.json(await createMyTicket(ctx, await parseBody(req, portalTicketSchema)), { status: 201 }));
export const OPTIONS = preflight;
