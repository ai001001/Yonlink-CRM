/**
 * GET /api/contacts — 全部可见联系人（跨客户，分页、搜索、筛选）/ all visible contacts across accounts.
 * 新建联系人仍通过 POST /api/accounts/:id/contacts / contacts are still created under an account.
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { contactListSchema, listAllContacts } from '@/server/modules/accounts';

export const GET = authedRoute(async (req, ctx) => Response.json(await listAllContacts(ctx, parseQuery(req, contactListSchema))));
export const OPTIONS = preflight;
