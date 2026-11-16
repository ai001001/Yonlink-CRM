/**
 * PATCH/DELETE /api/ticket-comments/:id — 修改、删除工单评论 / edit or delete a ticket comment.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { commentUpdateSchema, deleteComment, updateComment } from '@/server/modules/ticket-comments';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateComment(ctx, await routeId(route), await parseBody(req, commentUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteComment(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
