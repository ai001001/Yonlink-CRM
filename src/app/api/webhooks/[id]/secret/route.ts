/**
 * POST /api/webhooks/:id/secret — 重新生成签名密钥（旧密钥立即失效）。
 * Regenerate the signing secret (the old one stops working at once).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { regenerateSecret } from '@/server/modules/webhooks';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await regenerateSecret(ctx, await routeId(route))));
export const OPTIONS = preflight;
