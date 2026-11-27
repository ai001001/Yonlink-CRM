/**
 * GET /api/timeline?entity=lead|account|deal&id= — 记录的时间线（跟进、备注、修改记录合并，最新在前，before/exclude 分页）。
 * A record's timeline (activities, notes and changes merged, newest first; paged by before/exclude).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { getTimeline, timelineQuerySchema } from '@/server/modules/timeline';

export const GET = authedRoute(async (req, ctx) => Response.json(await getTimeline(ctx, parseQuery(req, timelineQuerySchema))));
export const OPTIONS = preflight;
