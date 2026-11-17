/**
 * GET/POST /api/purchase-orders — 采购单列表（需 purchase.read）与新建草稿（需 purchase.manage）/ purchase order list and create a draft.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createPurchaseOrder, listPurchaseOrders, poCreateSchema, poListSchema } from '@/server/modules/purchase-orders';

export const GET = authedRoute(async (req, ctx) => Response.json(await listPurchaseOrders(ctx, parseQuery(req, poListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createPurchaseOrder(ctx, await parseBody(req, poCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
