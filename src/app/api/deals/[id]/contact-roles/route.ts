/**
 * GET/POST /api/deals/:id/contact-roles — 商机联系人角色列表与新增 / list and add deal contact roles.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { addContactRole, contactRoleCreateSchema, listContactRoles } from '@/server/modules/deal-contact-roles';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await listContactRoles(ctx, await routeId(route))));
export const POST = authedRoute(async (req, ctx, route) => Response.json(await addContactRole(ctx, await routeId(route), await parseBody(req, contactRoleCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
