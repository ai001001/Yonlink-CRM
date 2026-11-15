/**
 * GET/POST /api/tickets — 服务工单列表（附各状态数量）与新建 / ticket list (with per-status counts) and create.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createTicket, listTickets, ticketCreateSchema, ticketListSchema } from '@/server/modules/tickets';

export const GET = authedRoute(async (req, ctx) => Response.json(await listTickets(ctx, parseQuery(req, ticketListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createTicket(ctx, await parseBody(req, ticketCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
