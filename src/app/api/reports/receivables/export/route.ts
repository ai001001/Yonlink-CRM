/**
 * GET /api/reports/receivables/export — 导出应收账款：CSV 明细（默认）或 Excel（format=xlsx，含汇总、按客户、明细）；
 * 需导出权限，写审计。
 * Export receivables as a CSV of open invoices (default) or Excel (format=xlsx: summary, by account, invoices); export
 * permission, audited.
 */
import { authedRoute, csvResponse, exportFormat, preflight, xlsxResponse } from '@/server/http';
import { exportReceivables } from '@/server/modules/receivables';
import { exportReceivablesXlsx } from '@/server/modules/report-xlsx';

export const GET = authedRoute(async (req, ctx) => {
  const { format, rest } = exportFormat(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (format === 'xlsx') {
    const x = await exportReceivablesXlsx(ctx, rest);
    return xlsxResponse(x.filename, x.data, { 'X-Export-Count': String(x.count), 'X-Export-Truncated': String(x.truncated) });
  }
  const r = await exportReceivables(ctx, rest);
  return csvResponse(r.filename, r.csv, { 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) });
});
export const OPTIONS = preflight;
