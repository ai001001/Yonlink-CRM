/**
 * POST /api/invoices/:id/void — 作废没有收款的发票 / void an invoice without payments.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { invoiceVoidSchema, voidInvoice } from '@/server/modules/invoices';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await voidInvoice(ctx, await routeId(route), await parseBody(req, invoiceVoidSchema))));
export const OPTIONS = preflight;
