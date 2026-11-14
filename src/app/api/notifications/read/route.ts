/**
 * POST /api/notifications/read — 标记指定或全部通知为已读 / mark given or all notifications read.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { markRead, notificationReadSchema } from '@/server/modules/notifications';

export const POST = authedRoute(async (req, ctx) => Response.json(await markRead(ctx, await parseBody(req, notificationReadSchema))));
export const OPTIONS = preflight;
