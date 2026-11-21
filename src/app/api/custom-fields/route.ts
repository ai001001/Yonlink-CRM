/**
 * GET/POST /api/custom-fields — 自定义字段定义（所有用户可读）与新建（需 customfield.manage）。
 * Custom field definitions: list (everyone) and create (customfield.manage).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createCustomField, customFieldCreateSchema, customFieldListSchema, listCustomFields } from '@/server/modules/custom-fields';

export const GET = authedRoute(async (req, ctx) => Response.json(await listCustomFields(ctx, parseQuery(req, customFieldListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createCustomField(ctx, await parseBody(req, customFieldCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
