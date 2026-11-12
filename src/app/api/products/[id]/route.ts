/**
 * GET/PATCH/DELETE /api/products/:id — 产品详情、修改、删除（被使用时只能停用）/ product detail, update, delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteProduct, getProduct, productUpdateSchema, updateProduct } from '@/server/modules/products';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getProduct(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateProduct(ctx, await routeId(route), await parseBody(req, productUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteProduct(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
