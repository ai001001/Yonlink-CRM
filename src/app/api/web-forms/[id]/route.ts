/**
 * GET/PATCH/DELETE /api/web-forms/:id — 网页表单详情、修改、删除（线索保留）/ detail, update, delete (leads stay).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteWebForm, getWebForm, updateWebForm, webFormUpdateSchema } from '@/server/modules/web-forms';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getWebForm(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateWebForm(ctx, await routeId(route), await parseBody(req, webFormUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteWebForm(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
