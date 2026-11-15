/**
 * PATCH/DELETE /api/deal-contact-roles/:id — 修改、移除商机联系人角色 / update or remove a deal contact role.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { contactRoleUpdateSchema, removeContactRole, updateContactRole } from '@/server/modules/deal-contact-roles';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateContactRole(ctx, await routeId(route), await parseBody(req, contactRoleUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await removeContactRole(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
