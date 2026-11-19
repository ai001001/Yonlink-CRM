/**
 * GET /api/products/stock-summary — 启用产品中的低库存与缺货数量。
 * Low and out-of-stock counts among active products.
 */
import { authedRoute, preflight } from '@/server/http';
import { stockSummary } from '@/server/modules/stock';

export const GET = authedRoute(async (_req, ctx) => Response.json(await stockSummary(ctx)));
export const OPTIONS = preflight;
