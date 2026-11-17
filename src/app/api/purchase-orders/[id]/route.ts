/**
 * GET/PATCH/DELETE /api/purchase-orders/:id — 采购单详情、修改（草稿可改明细）、删除（仅草稿）/ detail, update, delete (drafts only).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deletePurchaseOrder, getPurchaseOrder, poUpdateSchema, updatePurchaseOrder } from '@/server/modules/purchase-orders';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getPurchaseOrder(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updatePurchaseOrder(ctx, await routeId(route), await parseBody(req, poUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deletePurchaseOrder(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
