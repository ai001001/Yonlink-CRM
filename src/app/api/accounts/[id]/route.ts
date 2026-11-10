/**
 * GET/PATCH/DELETE /api/accounts/:id — 客户详情、编辑、删除 / account detail, update, delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { accountUpdateSchema, deleteAccount, getAccount, updateAccount } from '@/server/modules/accounts';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getAccount(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) =>
  Response.json(await updateAccount(ctx, await routeId(route), await parseBody(req, accountUpdateSchema))),
);
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteAccount(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
