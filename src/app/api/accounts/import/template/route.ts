/**
 * GET /api/accounts/import/template — 导入模板 / import template.
 */
import { authedRoute, csvResponse, preflight } from '@/server/http';
import { importTemplate, parseLang } from '@/server/modules/import-export';

export const GET = authedRoute(async (req) => {
  const r = importTemplate('accounts', parseLang(new URL(req.url).searchParams.get('lang')));
  return csvResponse(r.filename, r.csv);
});
export const OPTIONS = preflight;
