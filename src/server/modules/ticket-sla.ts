/**
 * 工单 SLA 与超时升级（对标 Zoho Escalation Rules）。
 * - 每个组织一条 SLA 规则：按优先级的处理时限（小时）、升级接收人、是否启用；没有记录即未启用。修改需 sla.manage，写审计。
 * - 启用时，新建工单未填处理期限则按优先级自动计算（dueAuto）；改优先级时自动期限随之重算；手动填写后不再自动。
 * - 超时升级：未解决工单超过处理期限时标记 escalatedAt，通知负责人与升级接收人，写系统审计（操作人为空）。
 *   系统没有定时任务，升级检查在读取通知、工单列表、工单详情、工作台时按需执行；条件更新保证每张工单只升级一次。
 * Ticket SLA and escalation (cf. Zoho escalation rules). One policy per organization: resolution hours per priority,
 * an escalation recipient and an enabled flag (no row = disabled); changing it needs sla.manage and is audited.
 * When enabled, new tickets without a due time get one from their priority (dueAuto) and auto due times follow
 * priority changes; a hand-set due time stays. Unresolved tickets past their due time are marked escalated, the owner
 * and the recipient are notified and a system audit entry (no actor) is written. There is no scheduler: the check
 * runs on demand when notifications, the ticket list or detail, or the dashboard are read; a conditional update
 * escalates each ticket once.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { NotificationType, type TicketPriority } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { requirePermission } from '../permissions';

/** 默认处理时限（小时）/ default resolution hours */
export const DEFAULT_SLA_HOURS: Record<TicketPriority, number> = { URGENT: 4, HIGH: 24, MEDIUM: 72, LOW: 168 };

const hours = z.number().int().min(1).max(8760);
/** 保存 SLA 规则 / Save the SLA policy */
export const slaSchema = z.strictObject({
  enabled: z.boolean(),
  urgentHours: hours,
  highHours: hours,
  mediumHours: hours,
  lowHours: hours,
  escalateToId: z.uuid().nullable(),
});

/** 生效中的规则 / Active policy */
export type SlaPolicy = { urgentHours: number; highHours: number; mediumHours: number; lowHours: number; escalateToId: string | null };

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * 读取组织已启用的 SLA 规则（未配置或已停用为 null）。
 * The organization's enabled SLA policy (null when absent or disabled).
 */
export async function activePolicy(db: Db, organizationId: string): Promise<SlaPolicy | null> {
  const row = await db.ticketSlaPolicy.findUnique({ where: { organizationId } });
  return row?.enabled ? row : null;
}

/**
 * 按优先级计算处理期限。
 * Due time for a priority.
 */
export function slaDue(policy: SlaPolicy, priority: TicketPriority, from: Date): Date {
  const h = { URGENT: policy.urgentHours, HIGH: policy.highHours, MEDIUM: policy.mediumHours, LOW: policy.lowHours }[priority];
  return new Date(from.getTime() + h * 3_600_000);
}

/**
 * 读取 SLA 规则（所有登录用户可读，用于显示）。
 * Read the SLA policy (any signed-in user; for display).
 */
export async function getSla(ctx: AuthContext) {
  const row = await prisma.ticketSlaPolicy.findUnique({ where: { organizationId: ctx.organizationId }, include: { escalateTo: { select: { id: true, name: true } } } });
  if (!row) {
    return { configured: false, enabled: false, urgentHours: DEFAULT_SLA_HOURS.URGENT, highHours: DEFAULT_SLA_HOURS.HIGH, mediumHours: DEFAULT_SLA_HOURS.MEDIUM, lowHours: DEFAULT_SLA_HOURS.LOW, escalateToId: null, escalateTo: null };
  }
  return {
    configured: true,
    enabled: row.enabled,
    urgentHours: row.urgentHours,
    highHours: row.highHours,
    mediumHours: row.mediumHours,
    lowHours: row.lowHours,
    escalateToId: row.escalateToId,
    escalateTo: row.escalateTo,
  };
}

/**
 * 保存 SLA 规则（需 sla.manage；升级接收人必须是本组织的在职用户）。
 * Save the SLA policy (sla.manage; the recipient must be an active user of the organization).
 */
export async function saveSla(ctx: AuthContext, input: z.infer<typeof slaSchema>) {
  requirePermission(ctx, 'sla.manage');
  if (input.escalateToId) {
    const ok = await prisma.user.count({ where: { id: input.escalateToId, organizationId: ctx.organizationId, isActive: true } });
    if (!ok) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid escalation recipient', { escalateToId: ['not_found'] });
  }
  await prisma.$transaction(async (tx) => {
    const before = await tx.ticketSlaPolicy.findUnique({ where: { organizationId: ctx.organizationId } });
    const after = await tx.ticketSlaPolicy.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...input }, update: input });
    const fields: Record<string, [unknown, unknown]> = {};
    for (const k of ['enabled', 'urgentHours', 'highHours', 'mediumHours', 'lowHours', 'escalateToId'] as const) {
      const b = before ? before[k] : null;
      if (b !== after[k]) fields[k] = [b, after[k]];
    }
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'sla.update', entityType: 'sla', entityId: ctx.organizationId, changes: { fields } });
  });
  return getSla(ctx);
}

/**
 * 升级本组织已超时的未解决工单（按需执行，幂等）。
 * Escalate the organization's overdue unresolved tickets (on demand, idempotent).
 * @returns 本次升级的工单数 / number of tickets escalated now
 */
export async function sweepEscalations(organizationId: string, now = new Date()): Promise<number> {
  const policy = await activePolicy(prisma, organizationId);
  if (!policy) return 0;
  return prisma.$transaction(async (tx) => {
    // 条件更新：并发执行时每张工单只会被其中一次返回 / conditional update: each ticket is returned to one sweep only
    const rows = await tx.$queryRaw<{ id: string; ticket_number: string; subject: string; owner_id: string | null; due_at: Date }[]>`
      UPDATE tickets SET escalated_at = ${now}
      WHERE organization_id = ${organizationId}::uuid AND escalated_at IS NULL AND due_at IS NOT NULL AND due_at < ${now}
        AND status IN ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER')
      RETURNING id::text, ticket_number, subject, owner_id::text, due_at`;
    for (const r of rows) {
      const recipients = [...new Set([r.owner_id, policy.escalateToId].filter((v): v is string => !!v))];
      await tx.notification.createMany({
        data: recipients.map((userId) => ({ organizationId, userId, type: NotificationType.TICKET_ESCALATED, ticketId: r.id, title: `${r.ticket_number} ${r.subject}`.slice(0, 200) })),
      });
      await audit(tx, { organizationId, actorId: null, action: 'ticket.escalate', entityType: 'ticket', entityId: r.id, changes: { dueAt: r.due_at.toISOString(), notified: recipients.length } });
    }
    return rows.length;
  });
}
