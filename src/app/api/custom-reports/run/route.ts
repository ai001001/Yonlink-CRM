/**
 * POST /api/custom-reports/run — 预览未保存的报表定义（?page=&pageSize= 分页明细）。
 * Preview an unsaved report definition (?page=&pageSize= page the details).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { definitionSchema, runDefinition, runQuerySchema } from '@/server/modules/custom-reports';

export const POST = authedRoute(async (req, ctx) => Response.json(await runDefinition(ctx, await parseBody(req, definitionSchema), parseQuery(req, runQuerySchema))));
export const OPTIONS = preflight;
