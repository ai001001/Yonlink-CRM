/**
 * POST /api/products/:id/stock/transfer — 仓库间调拨（需 product.manage；成对流水，总库存不变）。
 * Transfer stock between warehouses (product.manage; paired movements, total unchanged).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { stockTransferSchema, transferStock } from '@/server/modules/stock';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await transferStock(ctx, await routeId(route), await parseBody(req, stockTransferSchema))));
export const OPTIONS = preflight;
