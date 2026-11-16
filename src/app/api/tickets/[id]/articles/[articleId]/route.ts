/**
 * DELETE /api/tickets/:id/articles/:articleId — 取消工单与知识库文章的关联 / unlink a knowledge-base article from a ticket.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { unlinkArticle } from '@/server/modules/kb-articles';

export const DELETE = authedRoute(async (_req, ctx, route) => {
  await unlinkArticle(ctx, await routeId(route), await routeId(route, 'articleId'));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
