/**
 * GET /api/reports/sales/export — 导出销售报表：CSV（默认）或 Excel（format=xlsx，按板块分工作表）；需导出权限，写审计。
 * Export the sales report as CSV (default) or Excel (format=xlsx, one sheet per section); export permission, audited.
 */
import { authedRoute, csvResponse, exportFormat, preflight, xlsxResponse } from '@/server/http';
import { exportSalesReport } from '@/server/modules/report-exports';
import { exportSalesReportXlsx } from '@/server/modules/report-xlsx';

export const GET = authedRoute(async (req, ctx) => {
  const { format, rest } = exportFormat(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (format === 'xlsx') {
    const x = await exportSalesReportXlsx(ctx, rest);
    return xlsxResponse(x.filename, x.data, { 'X-Export-Count': String(x.count), 'X-Export-Truncated': String(x.truncated) });
  }
  const r = await exportSalesReport(ctx, rest);
  return csvResponse(r.filename, r.csv, { 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) });
});
export const OPTIONS = preflight;
