/**
 * GET/POST /api/accounts — 客户列表与新建 / list and create accounts.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { maskPage, maskRecord } from '@/server/field-security';
import { accountCreateSchema, accountListSchema, createAccount, listAccounts } from '@/server/modules/accounts';

export const GET = authedRoute(async (req, ctx) => Response.json(maskPage(ctx, 'ACCOUNT', await listAccounts(ctx, parseQuery(req, accountListSchema)))));
export const POST = authedRoute(async (req, ctx) =>
  Response.json(maskRecord(ctx, 'ACCOUNT', await createAccount(ctx, await parseBody(req, accountCreateSchema)), { contacts: 'CONTACT' }), { status: 201 }),
);
export const OPTIONS = preflight;
