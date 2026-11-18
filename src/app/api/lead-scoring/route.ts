/**
 * GET/PUT /api/lead-scoring — 线索评分规则与分级阈值（查看：所有用户；保存：需 scoring.manage，整体替换并重算）。
 * Lead scoring rules and grade thresholds (read: everyone; save: scoring.manage, replaces all and rescores).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { getScoring, saveScoring, scoringSaveSchema } from '@/server/modules/lead-scoring';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getScoring(ctx)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await saveScoring(ctx, await parseBody(req, scoringSaveSchema))));
export const OPTIONS = preflight;
