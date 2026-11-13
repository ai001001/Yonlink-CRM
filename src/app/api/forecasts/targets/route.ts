/**
 * PUT /api/forecasts/targets — 设定或清除某负责人某月的目标（需目标管理权限）/ set or clear a monthly target (forecast.manage).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { setTarget, targetSchema } from '@/server/modules/forecasts';

export const PUT = authedRoute(async (req, ctx) => Response.json(await setTarget(ctx, await parseBody(req, targetSchema))));
export const OPTIONS = preflight;
