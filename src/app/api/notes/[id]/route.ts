/**
 * PATCH/DELETE /api/notes/:id — 修改（仅作者）与删除备注 / edit (author only) and delete a note.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteNote, noteUpdateSchema, updateNote } from '@/server/modules/notes';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateNote(ctx, await routeId(route), await parseBody(req, noteUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteNote(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
