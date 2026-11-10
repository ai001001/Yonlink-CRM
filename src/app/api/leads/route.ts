/**
 * GET/POST /api/leads — 线索列表与新建 / list and create leads.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createLead, leadCreateSchema, leadListSchema, listLeads } from '@/server/modules/leads';

export const GET = authedRoute(async (req, ctx) => Response.json(await listLeads(ctx, parseQuery(req, leadListSchema))));
export const POST = authedRoute(async (req, ctx) =>
  Response.json(await createLead(ctx, await parseBody(req, leadCreateSchema)), { status: 201 }),
);
export const OPTIONS = preflight;
