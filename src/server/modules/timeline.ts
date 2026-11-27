/**
 * 记录时间线（整页详情使用）：把一条线索、客户或商机的跟进、备注与修改记录按时间合并（最新在前），每页 30 条。
 * - 记录必须对查看者可见（客户与商机含区域只读范围），否则 404。
 * - 跟进按查看者的可见范围（与跟进列表一致）；备注随记录可见；修改记录取该记录自身的审计（值已在写入时脱敏），
 *   没有审计查看权限时不返回 IP。
 * - 分页：before 为上一页最后一条的时间，exclude 为该时间点已返回的条目 ID（同一毫秒的条目不会漏掉或重复）。
 * Record timeline (full-page detail): a lead's, account's or deal's activities, notes and change history merged by time
 * (newest first), 30 per page. The record must be visible (territory read scope included) or 404. Activities follow
 * the viewer's visibility; notes follow the record; changes are the record's own audit entries (values redacted at
 * write time) without IPs unless the viewer may read audits. Paging: before = the last item's time, exclude = ids
 * already returned at that instant (no loss or duplicates within one millisecond).
 */
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { maskAuditEntries } from '../field-security';
import { notFound } from '../errors';
import { can, visible } from '../permissions';
import { readableAccounts, readableDeals, territoryReadScope } from './territory-rules';

/** 每页条数 / items per page */
export const TIMELINE_PAGE = 30;

/** 查询参数 / query */
export const timelineQuerySchema = z.strictObject({
  entity: z.enum(['lead', 'account', 'deal']),
  id: z.uuid(),
  before: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid_date')
    .optional(),
  exclude: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : [])),
});

/** 关联字段 / foreign key per entity */
const FK = { lead: 'leadId', account: 'accountId', deal: 'dealId' } as const;

/** 时间线条目 / a timeline item */
export type TimelineItem =
  | { kind: 'activity'; id: string; at: Date; activity: unknown }
  | { kind: 'note'; id: string; at: Date; note: unknown }
  | { kind: 'audit'; id: string; at: Date; entry: unknown };

/**
 * 读取记录的时间线一页。
 * Read one page of a record's timeline.
 */
export async function getTimeline(ctx: AuthContext, query: z.infer<typeof timelineQuerySchema>): Promise<{ items: TimelineItem[]; hasMore: boolean }> {
  const org = ctx.organizationId;
  const scope = await territoryReadScope(ctx);
  const found =
    query.entity === 'lead'
      ? await prisma.lead.count({ where: { id: query.id, ...visible(ctx) } })
      : query.entity === 'account'
        ? await prisma.account.count({ where: { AND: [{ id: query.id }, readableAccounts(ctx, scope)] } })
        : await prisma.deal.count({ where: { AND: [{ id: query.id }, readableDeals(ctx, scope)] } });
  if (!found) throw notFound();

  const fk = FK[query.entity];
  const time = query.before ? { lte: new Date(query.before) } : undefined;
  const notIn = query.exclude.length ? { notIn: query.exclude } : undefined;
  const take = TIMELINE_PAGE + query.exclude.length + 1;
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'asc' as const }];
  const [activities, notes, audits] = await Promise.all([
    prisma.activity.findMany({
      where: { AND: [visible(ctx), { [fk]: query.id, createdAt: time, id: notIn }] },
      select: { id: true, type: true, subject: true, dueAt: true, completed: true, createdAt: true, owner: { select: { id: true, name: true } } },
      orderBy,
      take,
    }),
    prisma.note.findMany({
      where: { organizationId: org, [fk]: query.id, createdAt: time, id: notIn },
      select: { id: true, content: true, createdAt: true, updatedAt: true, author: { select: { id: true, name: true } } },
      orderBy,
      take,
    }),
    prisma.auditLog.findMany({
      where: { organizationId: org, entityType: query.entity, entityId: query.id, createdAt: time, id: notIn },
      select: { id: true, action: true, entityType: true, entityId: true, changes: true, ip: true, createdAt: true, actor: { select: { id: true, name: true } } },
      orderBy,
      take,
    }),
  ]);
  const showIp = can(ctx, 'audit.read');
  const all: TimelineItem[] = [
    ...activities.map((a) => ({ kind: 'activity' as const, id: a.id, at: a.createdAt, activity: a })),
    ...notes.map((n) => ({ kind: 'note' as const, id: n.id, at: n.createdAt, note: n })),
    // 变更中的隐藏字段按字段权限去掉 / hidden fields are removed from the changes per field-level security
    ...(await maskAuditEntries(ctx, audits)).map((e) => ({ kind: 'audit' as const, id: e.id, at: e.createdAt, entry: { ...e, ip: showIp ? e.ip : null } })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime() || x.id.localeCompare(y.id));
  return { items: all.slice(0, TIMELINE_PAGE), hasMore: all.length > TIMELINE_PAGE };
}
