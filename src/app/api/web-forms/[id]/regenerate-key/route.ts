/**
 * POST /api/web-forms/:id/regenerate-key — 重新生成公开地址，旧地址立即失效 / regenerate the public URL; the old one stops working.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { regenerateKey } from '@/server/modules/web-forms';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await regenerateKey(ctx, await routeId(route))));
export const OPTIONS = preflight;
