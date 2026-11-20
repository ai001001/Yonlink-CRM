/**
 * PATCH/DELETE /api/webhooks/:id — 修改（名称、地址、启停）与删除 Webhook。
 * Update (name, URL, status) and delete a webhook.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteWebhook, updateWebhook, webhookUpdateSchema } from '@/server/modules/webhooks';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateWebhook(ctx, await routeId(route), await parseBody(req, webhookUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteWebhook(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
