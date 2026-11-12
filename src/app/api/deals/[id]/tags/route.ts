/**
 * PUT /api/deals/:id/tags — 设置商机的标签（完整集合，需能编辑该商机）/ set the deal's tags (full set; edit rights required).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { recordTagsSchema, setRecordTags } from '@/server/modules/tags';

export const PUT = authedRoute(async (req, ctx, route) => Response.json({ items: await setRecordTags(ctx, 'deal', await routeId(route), await parseBody(req, recordTagsSchema)) }));
export const OPTIONS = preflight;
