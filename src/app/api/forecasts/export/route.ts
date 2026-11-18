/**
 * GET /api/forecasts/export — 导出销售预测：CSV（默认）或 Excel（format=xlsx）；需导出权限，写审计。
 * Export the forecast as CSV (default) or Excel (format=xlsx); export permission, audited.
 */
import { authedRoute, csvResponse, exportFormat, preflight, xlsxResponse } from '@/server/http';
import { exportForecast } from '@/server/modules/report-exports';
import { exportForecastXlsx } from '@/server/modules/report-xlsx';

export const GET = authedRoute(async (req, ctx) => {
  const { format, rest } = exportFormat(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (format === 'xlsx') {
    const x = await exportForecastXlsx(ctx, rest);
    return xlsxResponse(x.filename, x.data, { 'X-Export-Count': String(x.count), 'X-Export-Truncated': String(x.truncated) });
  }
  const r = await exportForecast(ctx, rest);
  return csvResponse(r.filename, r.csv, { 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) });
});
export const OPTIONS = preflight;
