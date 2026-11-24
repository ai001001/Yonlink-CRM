/**
 * PATCH/DELETE /api/warehouses/:id — 修改与删除仓库（需 product.manage；默认仓库与有流水的仓库不能删除）。
 * Update and delete a warehouse (product.manage; the default and warehouses with movements cannot be deleted).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteWarehouse, updateWarehouse, warehouseUpdateSchema } from '@/server/modules/warehouses';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateWarehouse(ctx, await routeId(route), await parseBody(req, warehouseUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteWarehouse(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
