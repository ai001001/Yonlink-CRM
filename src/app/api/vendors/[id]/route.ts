/**
 * GET/PATCH/DELETE /api/vendors/:id — 供应商详情、修改、删除（有采购单时 409）/ vendor detail, update, delete (409 with purchase orders).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteVendor, getVendor, updateVendor, vendorUpdateSchema } from '@/server/modules/vendors';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getVendor(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateVendor(ctx, await routeId(route), await parseBody(req, vendorUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteVendor(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
