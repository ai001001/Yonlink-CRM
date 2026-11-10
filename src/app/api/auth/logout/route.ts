/**
 * POST /api/auth/logout — 注销当前会话 / revoke the current session.
 */
import { logout } from '@/server/auth';
import { preflight, publicRoute } from '@/server/http';

export const POST = publicRoute(async (req) => {
  await logout(req);
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
