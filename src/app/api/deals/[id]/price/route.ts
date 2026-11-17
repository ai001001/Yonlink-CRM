/**
 * GET /api/deals/:id/price — 预览新增明细的取价（价格表或产品目录价）/ preview a new item's price (price book or catalogue).
 */
import { authedRoute, parseQuery, preflight, routeId } from '@/server/http';
import { previewPrice } from '@/server/modules/deal-items';
import { priceQuerySchema } from '@/server/modules/price-books';

export const GET = authedRoute(async (req, ctx, route) => Response.json(await previewPrice(ctx, await routeId(route), parseQuery(req, priceQuerySchema))));
export const OPTIONS = preflight;
