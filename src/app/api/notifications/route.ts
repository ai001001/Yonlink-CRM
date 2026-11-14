/**
 * GET /api/notifications — 我的通知列表（先生成到期提醒）/ my notifications (reminders generated first).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { listNotifications, notificationListSchema } from '@/server/modules/notifications';

export const GET = authedRoute(async (req, ctx) => Response.json(await listNotifications(ctx, parseQuery(req, notificationListSchema))));
export const OPTIONS = preflight;
