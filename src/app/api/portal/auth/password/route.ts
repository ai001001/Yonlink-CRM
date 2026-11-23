/**
 * POST /api/portal/auth/password — 修改门户密码（其他会话失效）。
 * Change the portal password (other sessions are revoked).
 */
import { parseBody, preflight } from '@/server/http';
import { changePortalPassword, portalPasswordSchema, portalRoute } from '@/server/portal-auth';

export const POST = portalRoute(async (req, ctx) => {
  await changePortalPassword(ctx, await parseBody(req, portalPasswordSchema));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
