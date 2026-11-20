/**
 * POST /api/api-keys/:id/revoke — 吊销 API 密钥（立即失效）。
 * Revoke an API key (immediately).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { revokeApiKey } from '@/server/modules/api-keys';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await revokeApiKey(ctx, await routeId(route))));
export const OPTIONS = preflight;
