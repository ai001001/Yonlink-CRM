/**
 * PUT /api/leads/:id/tags — 设置线索的标签（完整集合，需能编辑该线索）/ set the lead's tags (full set; edit rights required).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { recordTagsSchema, setRecordTags } from '@/server/modules/tags';

export const PUT = authedRoute(async (req, ctx, route) => Response.json({ items: await setRecordTags(ctx, 'lead', await routeId(route), await parseBody(req, recordTagsSchema)) }));
export const OPTIONS = preflight;
