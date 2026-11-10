/**
 * POST /api/leads/:id/convert — 线索转化为客户 + 联系人 +（可选）商机 / convert a lead.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { convertLead, leadConvertSchema } from '@/server/modules/leads';

export const POST = authedRoute(async (req, ctx, route) =>
  Response.json(await convertLead(ctx, await routeId(route), await parseBody(req, leadConvertSchema))),
);
export const OPTIONS = preflight;
