/**
 * PUT /api/accounts/:id/tags — 设置客户的标签（完整集合，需能编辑该客户）/ set the account's tags (full set; edit rights required).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { recordTagsSchema, setRecordTags } from '@/server/modules/tags';

export const PUT = authedRoute(async (req, ctx, route) => Response.json({ items: await setRecordTags(ctx, 'account', await routeId(route), await parseBody(req, recordTagsSchema)) }));
export const OPTIONS = preflight;
