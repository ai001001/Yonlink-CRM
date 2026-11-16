/**
 * GET/POST /api/tickets/:id/comments — 工单评论列表与发表 / list and post ticket comments.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { addComment, commentCreateSchema, listComments } from '@/server/modules/ticket-comments';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await listComments(ctx, await routeId(route))));
export const POST = authedRoute(async (req, ctx, route) => Response.json(await addComment(ctx, await routeId(route), await parseBody(req, commentCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
