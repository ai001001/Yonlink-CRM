/**
 * GET/PATCH /api/sales-orders/:id — 订单详情、修改未结束的订单（订单不能删除，只能取消）/ order detail and update
 * (orders are cancelled, never deleted).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { getOrder, orderUpdateSchema, updateOrder } from '@/server/modules/sales-orders';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getOrder(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateOrder(ctx, await routeId(route), await parseBody(req, orderUpdateSchema))));
export const OPTIONS = preflight;
