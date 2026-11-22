/**
 * POST /api/macros/:id/run — 对选中的线索或商机执行宏（最多 100 条），返回逐条的成功与失败。
 * Run a macro on chosen leads or deals (at most 100), returning per-record successes and failures.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { macroRunSchema, runMacro } from '@/server/modules/macros';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await runMacro(ctx, await routeId(route), await parseBody(req, macroRunSchema))));
export const OPTIONS = preflight;
