/**
 * GET /api/forecasts/export — 导出销售预测 CSV（需导出权限，写审计）/ export the forecast as CSV (export permission, audited).
 */
import { authedRoute, csvResponse, preflight } from '@/server/http';
import { exportForecast } from '@/server/modules/report-exports';

export const GET = authedRoute(async (req, ctx) => {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const r = await exportForecast(ctx, params);
  return csvResponse(r.filename, r.csv, { 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) });
});
export const OPTIONS = preflight;
