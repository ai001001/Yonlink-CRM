/**
 * GET/POST /api/products/:id/stock — 产品库存流水（所有用户）与手工调整（需 product.manage）。
 * A product's stock movements (everyone) and manual adjustments (product.manage).
 */
import { authedRoute, parseBody, parseQuery, preflight, routeId } from '@/server/http';
import { adjustStock, listMovements, stockAdjustSchema, stockMovementQuerySchema } from '@/server/modules/stock';

export const GET = authedRoute(async (req, ctx, route) => Response.json(await listMovements(ctx, await routeId(route), parseQuery(req, stockMovementQuerySchema))));
export const POST = authedRoute(async (req, ctx, route) => Response.json(await adjustStock(ctx, await routeId(route), await parseBody(req, stockAdjustSchema))));
export const OPTIONS = preflight;
