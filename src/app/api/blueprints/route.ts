/**
 * GET/POST /api/blueprints — 流程蓝图列表与新建（需 blueprint.manage）。
 * List and create blueprints (blueprint.manage).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { blueprintCreateSchema, createBlueprint, listBlueprints } from '@/server/modules/blueprints';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listBlueprints(ctx)));
export const POST = authedRoute(async (req, ctx) => Response.json(await createBlueprint(ctx, await parseBody(req, blueprintCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
