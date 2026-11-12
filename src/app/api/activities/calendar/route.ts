/**
 * GET /api/activities/calendar — 按截止时间范围查询跟进（日历视图）/ activities due within a range (calendar view).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { activityCalendarSchema, listCalendar } from '@/server/modules/activities';

export const GET = authedRoute(async (req, ctx) => Response.json(await listCalendar(ctx, parseQuery(req, activityCalendarSchema))));
export const OPTIONS = preflight;
