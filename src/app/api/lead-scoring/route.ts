/**
 * GET/PUT /api/lead-scoring — 线索评分规则（兼容旧地址，等同 /api/scoring/lead）。
 * Lead scoring rules (kept for compatibility; same as /api/scoring/lead).
 */
import { ScoringEntity } from '@/generated/prisma/enums';
import { authedRoute, parseBody, preflight } from '@/server/http';
import { getScoring, saveScoring, scoringSaveSchema } from '@/server/modules/scoring';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getScoring(ctx, ScoringEntity.LEAD)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await saveScoring(ctx, ScoringEntity.LEAD, await parseBody(req, scoringSaveSchema(ScoringEntity.LEAD)))));
export const OPTIONS = preflight;
