/**
 * POST /api/cadences/:id/enroll — 把线索或商机加入销售节奏（最多 100 条），返回逐条的成功与失败。
 * Enroll leads or deals in a cadence (at most 100), returning per-record successes and failures.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { enroll, enrollSchema } from '@/server/modules/cadences';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await enroll(ctx, await routeId(route), await parseBody(req, enrollSchema))));
export const OPTIONS = preflight;
