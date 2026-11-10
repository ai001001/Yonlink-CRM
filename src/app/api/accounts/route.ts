/**
 * GET/POST /api/accounts — 客户列表与新建 / list and create accounts.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { accountCreateSchema, accountListSchema, createAccount, listAccounts } from '@/server/modules/accounts';

export const GET = authedRoute(async (req, ctx) => Response.json(await listAccounts(ctx, parseQuery(req, accountListSchema))));
export const POST = authedRoute(async (req, ctx) =>
  Response.json(await createAccount(ctx, await parseBody(req, accountCreateSchema)), { status: 201 }),
);
export const OPTIONS = preflight;
