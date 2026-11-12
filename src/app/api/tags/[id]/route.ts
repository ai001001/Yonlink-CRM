/**
 * PATCH/DELETE /api/tags/:id — 标签改名改色、删除（需标签管理权限）/ rename, recolour, delete a tag (tag.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteTag, tagUpdateSchema, updateTag } from '@/server/modules/tags';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateTag(ctx, await routeId(route), await parseBody(req, tagUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteTag(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
