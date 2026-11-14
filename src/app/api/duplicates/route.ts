/**
 * GET /api/duplicates?entity=leads|accounts — 查找重复记录（遵循可见范围）/ find duplicates within the visible records.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { duplicateQuerySchema, findDuplicates } from '@/server/modules/duplicates';

export const GET = authedRoute(async (req, ctx) => Response.json(await findDuplicates(ctx, parseQuery(req, duplicateQuerySchema))));
export const OPTIONS = preflight;
