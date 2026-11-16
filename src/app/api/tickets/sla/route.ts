/**
 * GET/PUT /api/tickets/sla — 读取（所有登录用户）与保存（需 sla.manage）工单 SLA 规则 / read (any user) or save (sla.manage) the ticket SLA policy.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { getSla, saveSla, slaSchema } from '@/server/modules/ticket-sla';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getSla(ctx)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await saveSla(ctx, await parseBody(req, slaSchema))));
export const OPTIONS = preflight;
