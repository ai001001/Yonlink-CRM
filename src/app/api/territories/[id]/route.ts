/**
 * PATCH/DELETE /api/territories/:id — 修改区域（成员整体替换）与删除区域（有下级时 409，客户变为无区域）。
 * Update a territory (members replaced) and delete it (409 with children; its accounts become unassigned).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteTerritory, territoryUpdateSchema, updateTerritory } from '@/server/modules/territories';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateTerritory(ctx, await routeId(route), await parseBody(req, territoryUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => Response.json(await deleteTerritory(ctx, await routeId(route))));
export const OPTIONS = preflight;
