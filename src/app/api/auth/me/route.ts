/**
 * GET /api/auth/me — 当前用户与组织 / current user and organization.
 */
import { prisma } from '@/server/db';
import { authedRoute, preflight } from '@/server/http';

export const GET = authedRoute(async (_req, ctx) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { id: true, name: true, email: true, organization: { select: { id: true, name: true } } },
  });
  return Response.json(user);
});
export const OPTIONS = preflight;
