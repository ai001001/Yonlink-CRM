/**
 * 站内通知与提醒（参考 Zoho CRM 的通知与提醒）。
 * - 分配通知：线索、客户、商机、跟进的负责人被他人改为某位用户时，在同一事务中通知新负责人
 *   （包括批量分配、查重合并选用其他负责人；自己分配给自己、负责人未变化时不通知；导入与线索转化不发通知）。
 * - 跟进提醒：未完成跟进在到期前 30 分钟内（或到期后 24 小时内）为负责人生成一条提醒；读取未读数或列表时
 *   按需生成，去重键含到期时间，改期后会重新提醒；跟进完成、改期、改负责人时撤销未读的旧提醒。
 * - 通知只属于接收人本人：所有读取与修改都按服务端会话的组织与用户限定；随所属记录删除；
 *   超过 90 天的通知在读取时清理。通知属于个人收件箱，已读、删除不写审计（触发通知的业务写操作本身已审计）。
 * In-app notifications and reminders (cf. Zoho CRM notifications and reminders).
 * - Assignment: when someone else makes a user the owner of a lead, account, deal or activity, the new owner is
 *   notified in the same transaction (including bulk assignment and merges that pick another owner; no notice for
 *   self-assignment or unchanged owners; imports and lead conversion do not notify).
 * - Reminders: a pending activity due within 30 minutes (or overdue by under 24 hours) yields one reminder for its
 *   owner, generated on demand when the unread count or list is read; the dedup key includes the due time so a
 *   rescheduled activity reminds again; completing, rescheduling or reassigning withdraws unread reminders.
 * - Notifications belong to the recipient only: every read and write is scoped to the session's organization and
 *   user; they are removed with their record and pruned after 90 days. Reading or deleting is not audited (the
 *   business writes that trigger notifications are).
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { NotificationType } from '@/generated/prisma/enums';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { notFound } from '../errors';

/** 到期前多久提醒 / how long before the due time to remind */
export const REMIND_BEFORE_MS = 30 * 60 * 1000;
/** 逾期多久内仍补发提醒 / how long after the due time a reminder is still generated */
export const REMIND_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** 通知保留天数 / retention in days */
export const RETENTION_DAYS = 90;
/** 每次生成提醒的上限 / max reminders generated per sync */
const SYNC_LIMIT = 100;

/** 通知关联的记录类型 / record types a notification can point at */
export type NotificationTarget = { entity: 'lead' | 'account' | 'deal' | 'activity'; id: string };

const TARGET_FIELD = { lead: 'leadId', account: 'accountId', deal: 'dealId', activity: 'activityId' } as const;

/** 列表查询 / List query */
export const notificationListSchema = z.strictObject({
  status: z.enum(['all', 'unread']).default('all'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/** 标记已读：指定通知或全部 / Mark read: given notifications or all */
export const notificationReadSchema = z.union([
  z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.strictObject({ all: z.literal(true) }),
]);

const select = {
  id: true,
  type: true,
  title: true,
  dueAt: true,
  readAt: true,
  createdAt: true,
  leadId: true,
  accountId: true,
  dealId: true,
  activityId: true,
  actor: { select: { id: true, name: true } },
} satisfies Prisma.NotificationSelect;

/** 接收人本人的通知 / the recipient's own notifications */
const mine = (ctx: AuthContext) => ({ organizationId: ctx.organizationId, userId: ctx.userId });

/**
 * 负责人变化时通知新负责人（在业务事务内调用）。
 * Notify the new owner when ownership changes (call inside the business transaction).
 * @param previous 原负责人；新建时为 null / previous owner; null on create
 */
export async function notifyAssigned(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  target: NotificationTarget,
  title: string,
  ownerId: string | null,
  previous: string | null,
): Promise<void> {
  if (!ownerId || ownerId === ctx.userId || ownerId === previous) return;
  await tx.notification.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ownerId,
      type: NotificationType.ASSIGNED,
      actorId: ctx.userId,
      [TARGET_FIELD[target.entity]]: target.id,
      title: title.slice(0, 200),
    },
  });
}

/**
 * 撤销某条跟进尚未阅读的提醒（完成、改期、改负责人时调用）。
 * Withdraw an activity's unread reminders (on completion, rescheduling or reassignment).
 */
export async function withdrawReminders(tx: Prisma.TransactionClient, organizationId: string, activityId: string): Promise<void> {
  await tx.notification.deleteMany({ where: { organizationId, activityId, type: NotificationType.ACTIVITY_DUE, readAt: null } });
}

/**
 * 为当前用户生成到期提醒，并清理过期通知（幂等：去重键唯一，并发时跳过重复）。
 * Generate due reminders for the current user and prune old notifications (idempotent: unique dedup keys,
 * duplicates skipped under concurrency).
 */
export async function syncReminders(ctx: AuthContext, now = new Date()): Promise<void> {
  const due = await prisma.activity.findMany({
    where: {
      organizationId: ctx.organizationId,
      ownerId: ctx.userId,
      completed: false,
      dueAt: { gte: new Date(now.getTime() - REMIND_LOOKBACK_MS), lte: new Date(now.getTime() + REMIND_BEFORE_MS) },
    },
    select: { id: true, subject: true, dueAt: true },
    orderBy: { dueAt: 'asc' },
    take: SYNC_LIMIT,
  });
  if (due.length) {
    await prisma.notification.createMany({
      data: due.map((a) => ({
        ...mine(ctx),
        type: NotificationType.ACTIVITY_DUE,
        activityId: a.id,
        title: a.subject,
        dueAt: a.dueAt,
        dedupKey: `due:${a.id}:${a.dueAt!.toISOString()}`,
      })),
      skipDuplicates: true,
    });
  }
  await prisma.notification.deleteMany({ where: { ...mine(ctx), createdAt: { lt: new Date(now.getTime() - RETENTION_DAYS * 86400000) } } });
}

/**
 * 未读数量（先生成到期提醒）。
 * Unread count (reminders are generated first).
 */
export async function unreadCount(ctx: AuthContext): Promise<{ count: number }> {
  await syncReminders(ctx);
  return { count: await prisma.notification.count({ where: { ...mine(ctx), readAt: null } }) };
}

/**
 * 我的通知列表（最新在前），附未读数。
 * My notifications, newest first, with the unread count.
 */
export async function listNotifications(ctx: AuthContext, query: z.infer<typeof notificationListSchema>) {
  await syncReminders(ctx);
  const where: Prisma.NotificationWhereInput = { ...mine(ctx), ...(query.status === 'unread' ? { readAt: null } : {}) };
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...mine(ctx), readAt: null } }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize, unread };
}

/**
 * 标记已读（只影响自己的未读通知）。
 * Mark notifications read (only my unread ones are affected).
 */
export async function markRead(ctx: AuthContext, input: z.infer<typeof notificationReadSchema>): Promise<{ updated: number }> {
  const where: Prisma.NotificationWhereInput = { ...mine(ctx), readAt: null, ...('ids' in input ? { id: { in: input.ids } } : {}) };
  const { count } = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  return { updated: count };
}

/**
 * 删除一条自己的通知。
 * Delete one of my notifications.
 */
export async function deleteNotification(ctx: AuthContext, id: string): Promise<void> {
  const { count } = await prisma.notification.deleteMany({ where: { ...mine(ctx), id } });
  if (count === 0) throw notFound();
}

/**
 * 清除自己的全部已读通知。
 * Clear all of my read notifications.
 */
export async function clearRead(ctx: AuthContext): Promise<{ deleted: number }> {
  const { count } = await prisma.notification.deleteMany({ where: { ...mine(ctx), readAt: { not: null } } });
  return { deleted: count };
}
