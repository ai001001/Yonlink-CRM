/**
 * GET /api/notifications/unread-count — 未读数量（先生成到期提醒）/ unread count (reminders generated first).
 */
import { authedRoute, preflight } from '@/server/http';
import { unreadCount } from '@/server/modules/notifications';

export const GET = authedRoute(async (_req, ctx) => Response.json(await unreadCount(ctx)));
export const OPTIONS = preflight;
