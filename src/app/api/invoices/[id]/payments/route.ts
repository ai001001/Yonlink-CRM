/**
 * POST /api/invoices/:id/payments — 登记收款 / record a payment.
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { addPayment, paymentCreateSchema } from '@/server/modules/invoices';

export const POST = authedRoute(async (req, ctx, route) => Response.json(await addPayment(ctx, await routeId(route), await parseBody(req, paymentCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
