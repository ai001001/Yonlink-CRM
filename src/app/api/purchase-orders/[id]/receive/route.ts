/**
 * POST /api/purchase-orders/:id/receive — 按行登记收货 / receive goods per line.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { poReceiveSchema, receivePurchaseOrder } from '@/server/modules/purchase-orders';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await receivePurchaseOrder(ctx, await routeId(route), await parseBody(req, poReceiveSchema))));
export const OPTIONS = preflight;
