/**
 * GET/POST /api/views — 列表的视图（自己的与共享的）与新建 / list views (mine and shared) and create one.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createView, listViews, viewCreateSchema, viewListSchema } from '@/server/modules/views';

export const GET = authedRoute(async (req, ctx) => Response.json(await listViews(ctx, parseQuery(req, viewListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createView(ctx, await parseBody(req, viewCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
