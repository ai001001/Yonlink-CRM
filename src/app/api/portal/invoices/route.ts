/**
 * GET /api/portal/invoices — 所属客户的发票（不含作废）。
 * The account's invoices (void excluded).
 */
import { preflight } from '@/server/http';
import { listMyInvoices } from '@/server/modules/portal';
import { portalRoute } from '@/server/portal-auth';

export const GET = portalRoute(async (_req, ctx) => Response.json(await listMyInvoices(ctx)));
export const OPTIONS = preflight;
