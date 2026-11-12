/**
 * GET/POST /api/notes — 某条线索/客户/商机的备注列表与新增 / list and add notes of a lead, account or deal.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createNote, listNotes, noteCreateSchema, noteListSchema } from '@/server/modules/notes';

export const GET = authedRoute(async (req, ctx) => Response.json(await listNotes(ctx, parseQuery(req, noteListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createNote(ctx, await parseBody(req, noteCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
