/**
 * GET/PUT /api/field-permissions — 字段权限设置（读取对象的设置；保存某个角色的设置）/ field permission setup (read an entity; save one role).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { fieldPermissionQuerySchema, fieldPermissionUpdateSchema, getFieldPermissions, updateFieldPermissions } from '@/server/modules/field-permissions';

export const GET = authedRoute(async (req, ctx) => Response.json(await getFieldPermissions(ctx, parseQuery(req, fieldPermissionQuerySchema).entity)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await updateFieldPermissions(ctx, await parseBody(req, fieldPermissionUpdateSchema))));
export const OPTIONS = preflight;
