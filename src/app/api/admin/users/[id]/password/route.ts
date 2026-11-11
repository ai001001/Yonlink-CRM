/**
 * POST /api/admin/users/:id/password — 重置密码并注销其会话（仅系统管理员）/ reset password (admins only).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { passwordResetSchema, resetPassword } from '@/server/modules/users';

export const POST = authedRoute(async (req, ctx, route) => {
  await resetPassword(ctx, await routeId(route), await parseBody(req, passwordResetSchema));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
