/**
 * DELETE /api/invoices/:id/payments/:paymentId — 撤销一笔收款 / revert a payment.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { deletePayment } from '@/server/modules/invoices';

export const DELETE = authedRoute(async (_req, ctx, route) => Response.json(await deletePayment(ctx, await routeId(route), await routeId(route, 'paymentId'))));
export const OPTIONS = preflight;
