/**
 * GET /api/accounts/import/template — 导入模板 / import template.
 */
import { authedRoute, csvResponse, preflight } from '@/server/http';
import { importTemplate } from '@/server/modules/import-export';

export const GET = authedRoute(async () => {
  const r = importTemplate('accounts');
  return csvResponse(r.filename, r.csv);
});
export const OPTIONS = preflight;
