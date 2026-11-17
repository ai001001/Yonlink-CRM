/**
 * GET/POST /api/price-books — 价格表列表（所有用户）与新建（需 product.manage）/ price book list and create.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createPriceBook, listPriceBooks, priceBookCreateSchema, priceBookListSchema } from '@/server/modules/price-books';

export const GET = authedRoute(async (req, ctx) => Response.json(await listPriceBooks(ctx, parseQuery(req, priceBookListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createPriceBook(ctx, await parseBody(req, priceBookCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
