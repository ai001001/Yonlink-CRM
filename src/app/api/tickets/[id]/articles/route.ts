/**
 * GET/POST /api/tickets/:id/articles — 工单关联的知识库文章列表与新增关联 / list and add knowledge-base articles linked to a ticket.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { linkArticle, listTicketArticles, ticketArticleSchema } from '@/server/modules/kb-articles';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await listTicketArticles(ctx, await routeId(route))));
export const POST = authedRoute(async (req, ctx, route) => Response.json(await linkArticle(ctx, await routeId(route), await parseBody(req, ticketArticleSchema)), { status: 201 }));
export const OPTIONS = preflight;
