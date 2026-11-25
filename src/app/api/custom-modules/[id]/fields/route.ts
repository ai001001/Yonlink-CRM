/**
 * GET/POST /api/custom-modules/:id/fields — 模块的字段（含停用的）与新建字段（需 customfield.manage）。
 * A module's fields (inactive included) and creating a field (customfield.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { createModuleField, listModuleFields, moduleFieldCreateSchema } from '@/server/modules/custom-modules';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await listModuleFields(ctx, await routeId(route))));
export const POST = authedRoute(async (req, ctx, route) => Response.json(await createModuleField(ctx, await routeId(route), await parseBody(req, moduleFieldCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
