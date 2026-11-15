/**
 * POST /api/profile/password — 修改我的密码（需当前密码；其他会话失效）/ change my password (current password required; other sessions revoked).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { changePassword, passwordChangeSchema } from '@/server/modules/profile';

export const POST = authedRoute(async (req, ctx) => Response.json(await changePassword(ctx, await parseBody(req, passwordChangeSchema))));
export const OPTIONS = preflight;
