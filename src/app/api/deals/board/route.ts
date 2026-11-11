/**
 * GET /api/deals/board — 商机销售漏斗看板数据 / deal pipeline board data.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { dealBoard, dealBoardSchema } from '@/server/modules/deals';

export const GET = authedRoute(async (req, ctx) => Response.json(await dealBoard(ctx, parseQuery(req, dealBoardSchema))));
export const OPTIONS = preflight;
