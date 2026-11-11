/**
 * GET /api/auth/me — 当前用户、组织、角色与权限（前端据此显示/隐藏操作，服务端仍逐请求校验）。
 * Current user, organization, role and permissions (the UI uses them; the server still checks every request).
 */
import { prisma } from '@/server/db';
import { authedRoute, preflight } from '@/server/http';
import { ROLE_PERMISSIONS } from '@/server/permissions';

export const GET = authedRoute(async (_req, ctx) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { id: true, name: true, email: true, role: true, isDemo: true, organization: { select: { id: true, name: true } } },
  });
  return Response.json({ ...user, permissions: ROLE_PERMISSIONS[user.role] });
});
export const OPTIONS = preflight;
