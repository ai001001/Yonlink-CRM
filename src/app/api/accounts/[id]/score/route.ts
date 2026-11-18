/**
 * GET /api/accounts/:id/score — 客户的得分明细与分级 / a account's score breakdown and grade.
 */
import { ScoringEntity } from '@/generated/prisma/enums';
import { authedRoute, preflight, routeId } from '@/server/http';
import { explainScore } from '@/server/modules/scoring';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await explainScore(ctx, ScoringEntity.ACCOUNT, await routeId(route))));
export const OPTIONS = preflight;
