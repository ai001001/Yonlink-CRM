/**
 * GET/PATCH/DELETE /api/custom-records/:id — 记录详情、修改（负责人或编辑全部权限）与删除（删除权限）。
 * Record detail, update (owner or update-all) and delete (delete permission).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteRecord, getRecord, recordUpdateSchema, updateRecord } from '@/server/modules/custom-modules';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getRecord(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateRecord(ctx, await routeId(route), await parseBody(req, recordUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteRecord(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
