/**
 * GET/POST /api/vendors — 供应商列表（需 purchase.read）与新建（需 purchase.manage）/ vendor list and create.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createVendor, listVendors, vendorCreateSchema, vendorListSchema } from '@/server/modules/vendors';

export const GET = authedRoute(async (req, ctx) => Response.json(await listVendors(ctx, parseQuery(req, vendorListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createVendor(ctx, await parseBody(req, vendorCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
