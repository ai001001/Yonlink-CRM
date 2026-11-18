/**
 * GET/POST /api/web-forms — 网页表单列表（所有用户）与新建（需 campaign.manage）/ web form list and create.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createWebForm, listWebForms, webFormCreateSchema, webFormListSchema } from '@/server/modules/web-forms';

export const GET = authedRoute(async (req, ctx) => Response.json(await listWebForms(ctx, parseQuery(req, webFormListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createWebForm(ctx, await parseBody(req, webFormCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
