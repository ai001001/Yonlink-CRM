/**
 * PUT /api/views/default — 设置或取消我在某个列表的默认视图 / set or clear my default view for a list.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { setDefaultView, viewDefaultSchema } from '@/server/modules/views';

export const PUT = authedRoute(async (req, ctx) => Response.json(await setDefaultView(ctx, await parseBody(req, viewDefaultSchema))));
export const OPTIONS = preflight;
