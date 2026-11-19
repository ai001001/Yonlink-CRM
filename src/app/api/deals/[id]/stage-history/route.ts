/**
 * GET /api/deals/:id/stage-history — 商机阶段历史（最新在前；商机不可见时 404）。
 * A deal's stage history, newest first (404 when the deal is not visible).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { getStageHistory } from '@/server/modules/deal-stage-history';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getStageHistory(ctx, await routeId(route))));
export const OPTIONS = preflight;
