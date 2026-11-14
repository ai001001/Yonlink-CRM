/**
 * POST /api/notifications/clear-read — 清除全部已读通知 / clear all read notifications.
 */
import { authedRoute, preflight } from '@/server/http';
import { clearRead } from '@/server/modules/notifications';

export const POST = authedRoute(async (_req, ctx) => Response.json(await clearRead(ctx)));
export const OPTIONS = preflight;
