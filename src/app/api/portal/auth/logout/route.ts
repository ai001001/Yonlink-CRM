/**
 * POST /api/portal/auth/logout — 退出客户门户。
 * Sign out of the customer portal.
 */
import { preflight } from '@/server/http';
import { portalLogout, portalRoute } from '@/server/portal-auth';

export const POST = portalRoute(async (_req, ctx) => {
  await portalLogout(ctx);
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
