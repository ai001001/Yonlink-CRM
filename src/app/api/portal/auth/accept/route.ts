/**
 * POST /api/portal/auth/accept — 接受门户邀请：设置密码、启用并登录。
 * Accept a portal invitation: set the password, activate and sign in.
 */
import { parseBody, preflight, publicRoute } from '@/server/http';
import { requestMeta } from '@/server/audit';
import { acceptInvite, portalAcceptSchema } from '@/server/portal-auth';

export const POST = publicRoute(async (req) => Response.json(await acceptInvite(await parseBody(req, portalAcceptSchema), requestMeta(req))));
export const OPTIONS = preflight;
