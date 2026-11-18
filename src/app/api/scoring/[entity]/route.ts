/**
 * GET/PUT /api/scoring/:entity — 线索（lead）、客户（account）、联系人（contact）的评分规则与分级阈值
 * （查看：所有用户；保存：需 scoring.manage，整体替换并重算）。
 * Scoring rules and thresholds for leads, accounts and contacts (read: everyone; save: scoring.manage, replaces and rescores).
 */
import { ApiError, authedRoute, parseBody, preflight, type RouteParams } from '@/server/http';
import { ENTITY_PARAM, entityParamSchema, getScoring, saveScoring, scoringSaveSchema } from '@/server/modules/scoring';

/** 读取对象参数，未知对象 404 / read the entity param; unknown entities are 404 */
async function entityOf(route: RouteParams) {
  const parsed = entityParamSchema.safeParse((await route.params).entity);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Record not found');
  return ENTITY_PARAM[parsed.data];
}

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getScoring(ctx, await entityOf(route))));
export const PUT = authedRoute(async (req, ctx, route) => {
  const entity = await entityOf(route);
  return Response.json(await saveScoring(ctx, entity, await parseBody(req, scoringSaveSchema(entity))));
});
export const OPTIONS = preflight;
