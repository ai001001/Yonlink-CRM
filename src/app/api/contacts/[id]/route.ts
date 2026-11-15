/**
 * GET/PATCH/DELETE /api/contacts/:id — 联系人详情、编辑、删除 / contact detail, update and delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { contactUpdateSchema, deleteContact, getContact, updateContact } from '@/server/modules/accounts';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getContact(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) =>
  Response.json(await updateContact(ctx, await routeId(route), await parseBody(req, contactUpdateSchema))),
);
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteContact(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
