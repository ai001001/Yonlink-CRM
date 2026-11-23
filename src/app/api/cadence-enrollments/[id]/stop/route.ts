/**
 * POST /api/cadence-enrollments/:id/stop — 停止进行中的参与（需能编辑记录）。
 * Stop an active enrollment (needs edit rights on the record).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { stopEnrollment } from '@/server/modules/cadences';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await stopEnrollment(ctx, await routeId(route))));
export const OPTIONS = preflight;
