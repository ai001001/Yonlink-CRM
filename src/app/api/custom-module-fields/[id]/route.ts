/**
 * PATCH/DELETE /api/custom-module-fields/:id — 修改（名称、选项、必填、启停）与删除模块字段（删除时清除各记录的值）。
 * Update (label, options, required, active) and delete a module field (deleting clears its values).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteModuleField, moduleFieldUpdateSchema, updateModuleField } from '@/server/modules/custom-modules';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateModuleField(ctx, await routeId(route), await parseBody(req, moduleFieldUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => Response.json(await deleteModuleField(ctx, await routeId(route))));
export const OPTIONS = preflight;
