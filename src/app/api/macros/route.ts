/**
 * GET/POST /api/macros — 当前用户可见的宏（共享的与自己的个人宏）与新建宏。
 * Macros visible to the user (shared and own personal) and create.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createMacro, listMacros, macroCreateSchema, macroListSchema } from '@/server/modules/macros';

export const GET = authedRoute(async (req, ctx) => Response.json(await listMacros(ctx, parseQuery(req, macroListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createMacro(ctx, await parseBody(req, macroCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
