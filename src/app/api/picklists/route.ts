/**
 * GET /api/picklists — 标准下拉字段的生效配置（所有用户可读）。
 * Effective standard picklist options (readable by everyone).
 */
import { authedRoute, preflight } from '@/server/http';
import { listPicklists } from '@/server/modules/picklists';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listPicklists(ctx)));
export const OPTIONS = preflight;
