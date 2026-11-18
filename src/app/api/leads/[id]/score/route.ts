/**
 * GET /api/leads/:id/score — 线索的得分明细与分级 / a lead's score breakdown and grade.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { explainScore } from '@/server/modules/lead-scoring';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await explainScore(ctx, await routeId(route))));
export const OPTIONS = preflight;
