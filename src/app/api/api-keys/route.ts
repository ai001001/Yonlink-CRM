/**
 * GET/POST /api/api-keys — API 密钥列表与新建（需 integration.manage 与浏览器会话；原文只在新建时返回）。
 * API keys: list and create (integration.manage and a browser session; the key is returned on creation only).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { apiKeyCreateSchema, createApiKey, listApiKeys } from '@/server/modules/api-keys';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listApiKeys(ctx)));
export const POST = authedRoute(async (req, ctx) => Response.json(await createApiKey(ctx, await parseBody(req, apiKeyCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
