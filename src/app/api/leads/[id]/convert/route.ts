/**
 * POST /api/leads/:id/convert — 线索转化为客户 + 联系人 +（可选）商机 / convert a lead.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { maskRecord } from '@/server/field-security';
import { convertLead, leadConvertSchema } from '@/server/modules/leads';

export const POST = authedRoute(async (req, ctx, route) => {
  const r = await convertLead(ctx, await routeId(route), await parseBody(req, leadConvertSchema));
  return Response.json({ ...r, lead: maskRecord(ctx, 'LEAD', r.lead), account: maskRecord(ctx, 'ACCOUNT', r.account) });
});
export const OPTIONS = preflight;
