/**
 * GET /api/webhooks/:id/deliveries — 投递记录（最新在前，可按状态筛选）。
 * Deliveries, newest first, filterable by status.
 */
import { authedRoute, parseQuery, preflight, routeId } from '@/server/http';
import { deliveryListSchema, listDeliveries } from '@/server/modules/webhooks';

export const GET = authedRoute(async (req, ctx, route) => Response.json(await listDeliveries(ctx, await routeId(route), parseQuery(req, deliveryListSchema))));
export const OPTIONS = preflight;
