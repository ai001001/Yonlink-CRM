/**
 * POST /api/quotes/:id/status — 变更报价单状态 / change the quote status.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { changeQuoteStatus, quoteStatusSchema } from '@/server/modules/quotes';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await changeQuoteStatus(ctx, await routeId(route), await parseBody(req, quoteStatusSchema))));
export const OPTIONS = preflight;
