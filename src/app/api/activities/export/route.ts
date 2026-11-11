/**
 * GET /api/activities/export — 按当前筛选导出 CSV（需导出权限，写审计）/ export CSV with the current filters.
 */
import { authedRoute, csvResponse, preflight } from '@/server/http';
import { exportCsv } from '@/server/modules/import-export';

export const GET = authedRoute(async (req, ctx) => {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const r = await exportCsv(ctx, 'activities', params);
  return csvResponse(r.filename, r.csv, { 'X-Export-Count': String(r.count), 'X-Export-Truncated': String(r.truncated) });
});
export const OPTIONS = preflight;
