/**
 * GET/POST /api/webhooks — Webhook 列表（集成管理员或工作流维护者）与新建（需 integration.manage；签名密钥只在新建时返回）。
 * Webhooks: list (integration or workflow maintainers) and create (integration.manage; the secret is returned once).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { createWebhook, listWebhooks, webhookCreateSchema } from '@/server/modules/webhooks';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listWebhooks(ctx)));
export const POST = authedRoute(async (req, ctx) => Response.json(await createWebhook(ctx, await parseBody(req, webhookCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
