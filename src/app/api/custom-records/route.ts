/**
 * GET/POST /api/custom-records — 自定义模块记录：按模块或关联客户分页搜索；新建（需 record.create）。
 * Custom module records: search by module or related account; create (record.create).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createRecord, listRecords, recordCreateSchema, recordListSchema } from '@/server/modules/custom-modules';

export const GET = authedRoute(async (req, ctx) => Response.json(await listRecords(ctx, parseQuery(req, recordListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createRecord(ctx, await parseBody(req, recordCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
