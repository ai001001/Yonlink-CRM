/**
 * PATCH/DELETE /api/roles/:id — 修改（名称、说明、权限）与删除自定义角色（有用户使用时 409）。
 * Update (name, description, permissions) and delete a custom role (409 while in use).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteRole, roleUpdateSchema, updateRole } from '@/server/modules/roles';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateRole(ctx, await routeId(route), await parseBody(req, roleUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteRole(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
