/**
 * GET /api/custom-reports/fields — 报表构建器的字段目录（各对象的字段、类型、可用条件与上限）。
 * The builder's field catalogue (fields, types, operators and limits per module).
 */
import { authedRoute, preflight } from '@/server/http';
import { reportCatalog } from '@/server/modules/custom-reports';

export const GET = authedRoute(async () => Response.json(reportCatalog()));
export const OPTIONS = preflight;
