/**
 * POST /api/purchase-orders/:id/status — 下单或取消 / order or cancel a purchase order.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { changePurchaseOrderStatus, poStatusSchema } from '@/server/modules/purchase-orders';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await changePurchaseOrderStatus(ctx, await routeId(route), await parseBody(req, poStatusSchema))));
export const OPTIONS = preflight;
