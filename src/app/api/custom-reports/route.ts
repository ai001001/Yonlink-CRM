/**
 * GET/POST /api/custom-reports — 可见的自定义报表（自己的与共享的）与新建。
 * Custom reports visible to the user (own and shared) and creating one.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { createReport, listReports, reportCreateSchema } from '@/server/modules/custom-reports';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listReports(ctx)));
export const POST = authedRoute(async (req, ctx) => Response.json(await createReport(ctx, await parseBody(req, reportCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
