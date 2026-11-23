/**
 * GET /api/portal/quotes — 所属客户的报价单（不含草稿）。
 * The account's quotes (drafts excluded).
 */
import { preflight } from '@/server/http';
import { listMyQuotes } from '@/server/modules/portal';
import { portalRoute } from '@/server/portal-auth';

export const GET = portalRoute(async (_req, ctx) => Response.json(await listMyQuotes(ctx)));
export const OPTIONS = preflight;
