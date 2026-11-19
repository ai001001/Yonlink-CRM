/**
 * GET /api/tickets/export — 按当前筛选导出服务工单 CSV（需导出权限，写审计）/ export tickets as CSV with the current filters.
 * 支持 format=xlsx 导出 Excel（同样的列与筛选，金额、数量为数字单元格）/ format=xlsx exports Excel (same columns and filters, numeric amounts and counts).
 */
import { authedRoute, csvResponse, exportFormat, preflight, xlsxResponse } from '@/server/http';
import { exportCsv, exportXlsx } from '@/server/modules/import-export';

export const GET = authedRoute(async (req, ctx) => {
  const { format, rest } = exportFormat(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const extra = (r: { count: number; truncated: boolean }) => ({ 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) });
  if (format === 'xlsx') {
    const x = await exportXlsx(ctx, 'tickets', rest);
    return xlsxResponse(x.filename, x.data, extra(x));
  }
  const r = await exportCsv(ctx, 'tickets', rest);
  return csvResponse(r.filename, r.csv, extra(r));
});
export const OPTIONS = preflight;
