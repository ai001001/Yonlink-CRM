/**
 * PATCH/DELETE /api/custom-fields/:id — 修改（标签、选项、必填、启停）与删除自定义字段（删除时清除各记录的值）。
 * Update (label, options, required, active) and delete a custom field (deleting clears its values).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { customFieldUpdateSchema, deleteCustomField, updateCustomField } from '@/server/modules/custom-fields';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateCustomField(ctx, await routeId(route), await parseBody(req, customFieldUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => Response.json(await deleteCustomField(ctx, await routeId(route))));
export const OPTIONS = preflight;
