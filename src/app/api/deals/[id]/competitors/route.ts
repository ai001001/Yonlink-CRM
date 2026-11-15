/**
 * GET/POST /api/deals/:id/competitors — 商机竞争对手列表与新增 / list and add deal competitors.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { addCompetitor, competitorCreateSchema, listCompetitors } from '@/server/modules/deal-competitors';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await listCompetitors(ctx, await routeId(route))));
export const POST = authedRoute(async (req, ctx, route) => Response.json(await addCompetitor(ctx, await routeId(route), await parseBody(req, competitorCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
