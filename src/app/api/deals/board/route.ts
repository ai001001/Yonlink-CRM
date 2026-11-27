/**
 * GET /api/deals/board — 商机销售漏斗看板数据 / deal pipeline board data.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { maskRecords } from '@/server/field-security';
import { dealBoard, dealBoardSchema } from '@/server/modules/deals';

export const GET = authedRoute(async (req, ctx) => {
  const board = await dealBoard(ctx, parseQuery(req, dealBoardSchema));
  return Response.json({ columns: board.columns.map((c) => ({ ...c, items: maskRecords(ctx, 'DEAL', c.items) })) });
});
export const OPTIONS = preflight;
