/**
 * GET /api/users — 本组织的有效用户（用于负责人选择）/ active users of the organization (owner picker).
 */
import { prisma } from '@/server/db';
import { authedRoute, preflight } from '@/server/http';

export const GET = authedRoute(async (_req, ctx) => {
  const items = await prisma.user.findMany({
    where: { organizationId: ctx.organizationId, isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
  return Response.json({ items });
});
export const OPTIONS = preflight;
