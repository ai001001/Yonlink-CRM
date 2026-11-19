/**
 * GET /api/reports/stage-duration — 阶段停留时长与成交周期（按时间段、负责人；遵循可见范围）。
 * Stage durations and sales cycle by period and owner (visibility applies).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { stageDurationQuerySchema, stageDurationReport } from '@/server/modules/deal-stage-history';

export const GET = authedRoute(async (req, ctx) => Response.json(await stageDurationReport(ctx, parseQuery(req, stageDurationQuerySchema))));
export const OPTIONS = preflight;
