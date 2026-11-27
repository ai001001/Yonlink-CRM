/**
 * GET/PATCH/DELETE /api/accounts/:id — 客户详情、编辑、删除 / account detail, update, delete.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { maskRecord } from '@/server/field-security';
import { accountUpdateSchema, deleteAccount, getAccount, updateAccount } from '@/server/modules/accounts';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(maskRecord(ctx, 'ACCOUNT', await getAccount(ctx, await routeId(route)), { contacts: 'CONTACT' })));
export const PATCH = authedRoute(async (req, ctx, route) =>
  Response.json(maskRecord(ctx, 'ACCOUNT', await updateAccount(ctx, await routeId(route), await parseBody(req, accountUpdateSchema)), { contacts: 'CONTACT' })),
);
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteAccount(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
