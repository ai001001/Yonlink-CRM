/**
 * GET/POST /api/tags — 标签列表（含使用次数）与新建 / list tags with usage counts and create one.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { createTag, listTags, tagCreateSchema } from '@/server/modules/tags';

export const GET = authedRoute(async (_req, ctx) => Response.json({ items: await listTags(ctx) }));
export const POST = authedRoute(async (req, ctx) => Response.json(await createTag(ctx, await parseBody(req, tagCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
