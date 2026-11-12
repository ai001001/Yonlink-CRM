/**
 * PATCH/DELETE /api/deal-items/:id — 修改、删除商机产品明细 / update or remove a deal line item.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { itemUpdateSchema, removeItem, updateItem } from '@/server/modules/deal-items';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateItem(ctx, await routeId(route), await parseBody(req, itemUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => Response.json(await removeItem(ctx, await routeId(route))));
export const OPTIONS = preflight;
