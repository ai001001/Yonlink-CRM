/**
 * POST /api/sales-orders/:id/status — 变更订单状态（发货、交付、取消）/ change the order status (ship, deliver, cancel).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { changeOrderStatus, orderStatusSchema } from '@/server/modules/sales-orders';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await changeOrderStatus(ctx, await routeId(route), await parseBody(req, orderStatusSchema))));
export const OPTIONS = preflight;
