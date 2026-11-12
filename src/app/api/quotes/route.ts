/**
 * GET/POST /api/quotes — 报价单列表与由商机生成报价单 / list quotes and create one from a deal.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createQuote, listQuotes, quoteCreateSchema, quoteListSchema } from '@/server/modules/quotes';

export const GET = authedRoute(async (req, ctx) => Response.json(await listQuotes(ctx, parseQuery(req, quoteListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createQuote(ctx, await parseBody(req, quoteCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
