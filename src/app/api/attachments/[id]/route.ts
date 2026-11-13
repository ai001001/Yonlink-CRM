/**
 * DELETE /api/attachments/:id — 删除附件 / delete an attachment.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { deleteAttachment } from '@/server/modules/attachments';

export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteAttachment(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
