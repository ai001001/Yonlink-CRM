/**
 * GET /api/custom-reports/:id/export — 导出报表（CSV，或 format=xlsx 导出 Excel；需导出权限，写审计）。
 * Export a report (CSV, or Excel with format=xlsx; export permission, audited).
 */
import { authedRoute, csvResponse, parseQuery, preflight, routeId, xlsxResponse } from '@/server/http';
import { exportReport, reportExportSchema } from '@/server/modules/custom-reports';

export const GET = authedRoute(async (req, ctx, route) => {
  const r = await exportReport(ctx, await routeId(route), parseQuery(req, reportExportSchema));
  const extra = { 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) };
  return r.kind === 'xlsx' ? xlsxResponse(r.filename, r.data, extra) : csvResponse(r.filename, r.csv, extra);
});
export const OPTIONS = preflight;
