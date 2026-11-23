/**
 * GET/POST /api/cadences — 销售节奏列表（所有用户可读，含参与数）与新建（需 cadence.manage）。
 * Cadences with enrollment counts (everyone) and create (cadence.manage).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { cadenceCreateSchema, cadenceListSchema, createCadence, listCadences } from '@/server/modules/cadences';

export const GET = authedRoute(async (req, ctx) => Response.json(await listCadences(ctx, parseQuery(req, cadenceListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createCadence(ctx, await parseBody(req, cadenceCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
