/**
 * PUT /api/price-books/:id/entries — 设置产品价格（新增或修改）/ set a product's list price (add or change).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { priceBookEntrySchema, setEntry } from '@/server/modules/price-books';

export const PUT = authedRoute(async (req, ctx, route) => Response.json(await setEntry(ctx, await routeId(route), await parseBody(req, priceBookEntrySchema))));
export const OPTIONS = preflight;
