/**
 * GET /api/auth/me — 当前用户、组织、角色与权限（前端据此显示/隐藏操作，服务端仍逐请求校验）。
 * Current user, organization, role (and custom role) and effective permissions (the UI uses them; the server still checks every request).
 */
import { prisma } from '@/server/db';
import { authedRoute, preflight } from '@/server/http';
import { effectivePermissions } from '@/server/permissions';

export const GET = authedRoute(async (_req, ctx) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { id: true, name: true, email: true, role: true, isDemo: true, organization: { select: { id: true, name: true } }, customRole: { select: { id: true, name: true, permissions: true } } },
  });
  const { customRole, ...rest } = user;
  // 自定义角色的权限优先（只保留可授予的）/ a custom role's permissions take precedence (grantable ones only)
  return Response.json({ ...rest, customRole: customRole ? { id: customRole.id, name: customRole.name } : null, permissions: effectivePermissions(user.role, customRole?.permissions) });
});
export const OPTIONS = preflight;
