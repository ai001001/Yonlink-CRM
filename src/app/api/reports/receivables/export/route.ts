/**
 * GET /api/reports/receivables/export — 导出应收账款明细 CSV（需导出权限，写审计）/ export the receivables as CSV.
 */
import { authedRoute, csvResponse, preflight } from '@/server/http';
import { exportReceivables } from '@/server/modules/receivables';

export const GET = authedRoute(async (req, ctx) => {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const r = await exportReceivables(ctx, params);
  return csvResponse(r.filename, r.csv, { 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) });
});
export const OPTIONS = preflight;
