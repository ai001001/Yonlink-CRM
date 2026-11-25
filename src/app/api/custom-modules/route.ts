/**
 * GET/POST /api/custom-modules — 自定义模块列表（所有用户可读；?active=true 只含启用的）与新建（需 customfield.manage）。
 * Custom modules: list (everyone; ?active=true for active ones) and create (customfield.manage).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createModule, listModules, moduleCreateSchema, moduleListSchema } from '@/server/modules/custom-modules';

export const GET = authedRoute(async (req, ctx) => Response.json(await listModules(ctx, parseQuery(req, moduleListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createModule(ctx, await parseBody(req, moduleCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
