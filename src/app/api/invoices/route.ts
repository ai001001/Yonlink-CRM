/**
 * GET/POST /api/invoices — 发票列表、由销售订单生成发票 / list invoices and create one from a sales order.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createInvoice, invoiceCreateSchema, invoiceListSchema, listInvoices } from '@/server/modules/invoices';

export const GET = authedRoute(async (req, ctx) => Response.json(await listInvoices(ctx, parseQuery(req, invoiceListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createInvoice(ctx, await parseBody(req, invoiceCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
