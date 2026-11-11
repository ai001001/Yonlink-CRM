/**
 * GET/POST /api/admin/users — 用户列表与新建（仅系统管理员）/ list and create users (admins only).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { createUser, listUsers, userCreateSchema } from '@/server/modules/users';

export const GET = authedRoute(async (_req, ctx) => Response.json({ items: await listUsers(ctx) }));
export const POST = authedRoute(async (req, ctx) => Response.json(await createUser(ctx, await parseBody(req, userCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
