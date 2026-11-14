/**
 * GET/PATCH /api/invoices/:id — 发票详情、修改未作废的发票（发票不能删除，只能作废）/ invoice detail and update
 * (invoices are voided, never deleted).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { getInvoice, invoiceUpdateSchema, updateInvoice } from '@/server/modules/invoices';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getInvoice(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateInvoice(ctx, await routeId(route), await parseBody(req, invoiceUpdateSchema))));
export const OPTIONS = preflight;
