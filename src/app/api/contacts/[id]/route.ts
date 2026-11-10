/**
 * PATCH/DELETE /api/contacts/:id — 编辑、删除联系人 / update or delete a contact.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { contactUpdateSchema, deleteContact, updateContact } from '@/server/modules/accounts';

export const PATCH = authedRoute(async (req, ctx, route) =>
  Response.json(await updateContact(ctx, await routeId(route), await parseBody(req, contactUpdateSchema))),
);
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteContact(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
