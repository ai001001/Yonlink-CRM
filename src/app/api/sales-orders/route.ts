/**
 * GET/POST /api/sales-orders — 订单列表、由已接受的报价单生成订单 / list orders and create one from an accepted quote.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createOrder, listOrders, orderCreateSchema, orderListSchema } from '@/server/modules/sales-orders';

export const GET = authedRoute(async (req, ctx) => Response.json(await listOrders(ctx, parseQuery(req, orderListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createOrder(ctx, await parseBody(req, orderCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
