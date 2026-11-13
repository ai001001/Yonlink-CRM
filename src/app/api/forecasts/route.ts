/**
 * GET /api/forecasts — 销售目标与预测（按月或季度、币种）/ sales targets and forecast by month or quarter and currency.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { forecastQuerySchema, getForecast } from '@/server/modules/forecasts';

export const GET = authedRoute(async (req, ctx) => Response.json(await getForecast(ctx, parseQuery(req, forecastQuerySchema))));
export const OPTIONS = preflight;
