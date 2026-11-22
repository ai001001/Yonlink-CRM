/**
 * GET /api/blueprints/status?entity= — 对象当前启用的蓝图（所有用户可读，表单用于锁定受控字段）。
 * The active blueprint of an entity (everyone; forms use it to lock the controlled field).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { blueprintEntitySchema, blueprintStatus } from '@/server/modules/blueprints';

export const GET = authedRoute(async (req, ctx) => Response.json(await blueprintStatus(ctx, parseQuery(req, blueprintEntitySchema).entity)));
export const OPTIONS = preflight;
