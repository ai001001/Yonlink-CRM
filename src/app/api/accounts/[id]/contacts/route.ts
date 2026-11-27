/**
 * GET/POST /api/accounts/:id/contacts — 客户联系人列表与新建 / list and create contacts of an account.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { maskRecord, maskRecords } from '@/server/field-security';
import { contactCreateSchema, createContact, listContacts } from '@/server/modules/accounts';

export const GET = authedRoute(async (_req, ctx, route) => Response.json({ items: maskRecords(ctx, 'CONTACT', await listContacts(ctx, await routeId(route))) }));
export const POST = authedRoute(async (req, ctx, route) =>
  Response.json(maskRecord(ctx, 'CONTACT', await createContact(ctx, await routeId(route), await parseBody(req, contactCreateSchema))), { status: 201 }),
);
export const OPTIONS = preflight;
