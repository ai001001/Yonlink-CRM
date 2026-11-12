/**
 * GET/POST /api/deals/:id/items — 商机产品明细列表与新增 / list and add deal line items.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { addItem, itemCreateSchema, listItems } from '@/server/modules/deal-items';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await listItems(ctx, await routeId(route))));
export const POST = authedRoute(async (req, ctx, route) => Response.json(await addItem(ctx, await routeId(route), await parseBody(req, itemCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
