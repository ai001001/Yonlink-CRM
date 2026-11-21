/**
 * GET/POST /api/territories — 区域列表与统计（所有用户可读，统计按可见记录；view=options 只返回选项）与新建（需 territory.manage）。
 * Territories with statistics (everyone; statistics use visible records; view=options returns options only) and create (territory.manage).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createTerritory, listTerritories, listTerritoryOptions, territoryCreateSchema, territoryListSchema } from '@/server/modules/territories';

export const GET = authedRoute(async (req, ctx) =>
  Response.json(parseQuery(req, territoryListSchema).view === 'options' ? await listTerritoryOptions(ctx) : await listTerritories(ctx)),
);
export const POST = authedRoute(async (req, ctx) => Response.json(await createTerritory(ctx, await parseBody(req, territoryCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
