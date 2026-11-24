/**
 * GET/POST /api/warehouses — 仓库列表（所有用户可读，含库存统计）与新建（需 product.manage）。
 * Warehouses with stock statistics (everyone) and create (product.manage).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { createWarehouse, listWarehouses, warehouseCreateSchema } from '@/server/modules/warehouses';

export const GET = authedRoute(async (_req, ctx) => Response.json(await listWarehouses(ctx)));
export const POST = authedRoute(async (req, ctx) => Response.json(await createWarehouse(ctx, await parseBody(req, warehouseCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
