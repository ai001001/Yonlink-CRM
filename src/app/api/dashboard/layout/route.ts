/**
 * GET/PUT/DELETE /api/dashboard/layout — 读取、保存、恢复默认个人工作台布局 / read, save or reset the personal dashboard layout.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { getLayout, layoutSchema, resetLayout, saveLayout } from '@/server/modules/dashboard-layout';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getLayout(ctx)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await saveLayout(ctx, await parseBody(req, layoutSchema))));
export const DELETE = authedRoute(async (_req, ctx) => Response.json(await resetLayout(ctx)));
export const OPTIONS = preflight;
