/**
 * 审计日志查询服务（只读，按组织隔离）。
 * Audit log query service (read-only, organization scoped).
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { requirePermission } from '../permissions';
import { listQuery, type Page } from '../validation';

const ENTITY_TYPES = ['lead', 'account', 'contact', 'deal', 'activity', 'user', 'auth'] as const;

/**
 * 查询参数（严格模式：未知参数报错，避免把拼错的筛选条件静默忽略后返回全部日志）。
 * Query parameters (strict: unknown params fail instead of silently returning unfiltered logs).
 */
export const auditListSchema = listQuery.omit({ q: true }).strict().extend({
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  action: z.string().regex(/^[a-z]+\.[a-z_]+$/).max(50).optional(),
  actorId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/**
 * 分页查询审计日志（最新在前）。
 * List audit logs with pagination, newest first.
 */
export async function listAuditLogs(ctx: AuthContext, query: z.infer<typeof auditListSchema>): Promise<Page<unknown>> {
  requirePermission(ctx, 'audit.read');
  const where: Prisma.AuditLogWhereInput = {
    organizationId: ctx.organizationId,
    entityType: query.entityType,
    entityId: query.entityId,
    action: query.action,
    actorId: query.actorId,
    createdAt: query.from || query.to ? { gte: query.from ? new Date(query.from) : undefined, lt: query.to ? new Date(query.to) : undefined } : undefined,
  };
  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}
