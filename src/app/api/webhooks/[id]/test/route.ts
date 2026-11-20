/**
 * POST /api/webhooks/:id/test — 发送测试事件（ping）并返回结果。
 * Send a test (ping) event and return the result.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { testWebhook } from '@/server/modules/webhooks';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await testWebhook(ctx, await routeId(route))));
export const OPTIONS = preflight;
