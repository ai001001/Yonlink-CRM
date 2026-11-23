/**
 * GET /api/contacts/:id/portal — 联系人的门户开通状态（需 portal.manage，联系人须可见）。
 * A contact's portal access (portal.manage; the contact must be visible).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { getContactPortal } from '@/server/modules/portal';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getContactPortal(ctx, await routeId(route))));
export const OPTIONS = preflight;
