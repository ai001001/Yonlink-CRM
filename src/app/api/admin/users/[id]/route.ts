/**
 * PATCH /api/admin/users/:id — 修改姓名、角色、启用状态（仅系统管理员）/ update a user (admins only).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { updateUser, userUpdateSchema } from '@/server/modules/users';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateUser(ctx, await routeId(route), await parseBody(req, userUpdateSchema))));
export const OPTIONS = preflight;
