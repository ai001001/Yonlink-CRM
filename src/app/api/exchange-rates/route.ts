/**
 * GET/PUT /api/exchange-rates — 汇率（当前与历史）；录入或修改某币种某日的汇率（管理员）/ rates (current and
 * history); enter or update a rate for a currency and date (admins).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { listRates, rateSaveSchema, saveRate } from '@/server/modules/exchange-rates';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listRates(ctx)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await saveRate(ctx, await parseBody(req, rateSaveSchema))));
export const OPTIONS = preflight;
