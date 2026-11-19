/**
 * GET /api/deals/:id/score — 商机的得分明细与分级 / a deal's score breakdown and grade.
 */
import { ScoringEntity } from '@/generated/prisma/enums';
import { authedRoute, preflight, routeId } from '@/server/http';
import { explainScore } from '@/server/modules/scoring';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await explainScore(ctx, ScoringEntity.DEAL, await routeId(route))));
export const OPTIONS = preflight;
