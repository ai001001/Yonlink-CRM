/**
 * GET /api/search?q= — 全局搜索 / global search.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { globalSearch, searchSchema } from '@/server/modules/dashboard';

export const GET = authedRoute(async (req, ctx) => Response.json(await globalSearch(ctx, parseQuery(req, searchSchema).q)));
export const OPTIONS = preflight;
