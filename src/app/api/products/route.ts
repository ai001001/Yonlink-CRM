/**
 * GET/POST /api/products — 产品列表与新建（新建需产品管理权限）/ list and create products.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createProduct, listProducts, productCreateSchema, productListSchema } from '@/server/modules/products';

export const GET = authedRoute(async (req, ctx) => Response.json(await listProducts(ctx, parseQuery(req, productListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createProduct(ctx, await parseBody(req, productCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
