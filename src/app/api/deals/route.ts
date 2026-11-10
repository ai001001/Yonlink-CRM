/**
 * GET/POST /api/deals — 商机列表（含金额合计）与新建 / list (with totals) and create deals.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createDeal, dealCreateSchema, dealListSchema, listDeals } from '@/server/modules/deals';

export const GET = authedRoute(async (req, ctx) => Response.json(await listDeals(ctx, parseQuery(req, dealListSchema))));
export const POST = authedRoute(async (req, ctx) =>
  Response.json(await createDeal(ctx, await parseBody(req, dealCreateSchema)), { status: 201 }),
);
export const OPTIONS = preflight;
