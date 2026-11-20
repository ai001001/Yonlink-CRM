/**
 * POST /api/webhook-deliveries/:id/retry — 手动重试失败的投递。
 * Retry a failed delivery manually.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { retryDelivery } from '@/server/modules/webhooks';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await retryDelivery(ctx, await routeId(route))));
export const OPTIONS = preflight;
