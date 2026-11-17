/**
 * POST /api/price-books/:id/accounts — 指定为客户的默认价格表 / make the book an account's default.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { assignAccount, priceBookAccountSchema } from '@/server/modules/price-books';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await assignAccount(ctx, await routeId(route), (await parseBody(req, priceBookAccountSchema)).accountId)));
export const OPTIONS = preflight;
