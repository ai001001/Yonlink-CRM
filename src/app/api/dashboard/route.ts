/**
 * GET /api/dashboard — 工作台统计 / dashboard statistics.
 */
import { authedRoute, preflight } from '@/server/http';
import { getDashboard } from '@/server/modules/dashboard';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getDashboard(ctx)));
export const OPTIONS = preflight;
