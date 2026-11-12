/**
 * POST /api/quotes/:id/sync — 草稿从商机重新同步产品明细 / re-sync a draft's lines from the deal.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { syncQuote } from '@/server/modules/quotes';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await syncQuote(ctx, await routeId(route))));
export const OPTIONS = preflight;
