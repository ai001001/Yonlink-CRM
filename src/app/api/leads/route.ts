/**
 * GET/POST /api/leads — 线索列表与新建 / list and create leads.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { maskPage, maskRecord } from '@/server/field-security';
import { createLead, leadCreateSchema, leadListSchema, listLeads } from '@/server/modules/leads';

export const GET = authedRoute(async (req, ctx) => Response.json(maskPage(ctx, 'LEAD', await listLeads(ctx, parseQuery(req, leadListSchema)))));
export const POST = authedRoute(async (req, ctx) =>
  Response.json(maskRecord(ctx, 'LEAD', await createLead(ctx, await parseBody(req, leadCreateSchema))), { status: 201 }),
);
export const OPTIONS = preflight;
