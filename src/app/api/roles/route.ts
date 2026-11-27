/**
 * GET/POST /api/roles — 系统角色、自定义角色与可授予的权限目录；新建自定义角色（需 user.manage）。
 * System roles, custom roles and the grantable catalogue; create a custom role (user.manage).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { createRole, listRoles, roleCreateSchema } from '@/server/modules/roles';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listRoles(ctx)));
export const POST = authedRoute(async (req, ctx) => Response.json(await createRole(ctx, await parseBody(req, roleCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
