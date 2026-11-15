/**
 * POST /api/profile/sessions/revoke-others — 退出其他所有设备 / sign out of all other devices.
 */
import { authedRoute, preflight } from '@/server/http';
import { revokeOtherSessions } from '@/server/modules/profile';

export const POST = authedRoute(async (_req, ctx) => Response.json(await revokeOtherSessions(ctx)));
export const OPTIONS = preflight;
