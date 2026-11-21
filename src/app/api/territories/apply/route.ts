/**
 * POST /api/territories/apply — 按规则重新分配全部非手工指定的客户（需 territory.manage）。
 * Re-apply territory rules to every account not set by hand (territory.manage).
 */
import { authedRoute, preflight } from '@/server/http';
import { applyTerritoryRules } from '@/server/modules/territories';

export const POST = authedRoute(async (_req, ctx) => Response.json(await applyTerritoryRules(ctx)));
export const OPTIONS = preflight;
