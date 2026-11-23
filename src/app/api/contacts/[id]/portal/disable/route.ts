/**
 * POST /api/contacts/:id/portal/disable — 停用联系人的门户（清除邀请、结束全部会话）。
 * Disable a contact's portal access (clear the invitation and end all sessions).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { disablePortal } from '@/server/modules/portal';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await disablePortal(ctx, await routeId(route))));
export const OPTIONS = preflight;
