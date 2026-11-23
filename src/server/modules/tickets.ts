/**
 * 服务工单（对标 Zoho Cases）：客户的问题、故障与需求，从新建、处理、等待客户到解决、关闭。
 * - 工单属于一个客户，可指定该客户的联系人；工单号 CS-年份-序号由计数器原子分配，删除后不复用。
 * - 进入“已解决/已关闭”必须填写解决方案，并记录解决时间；回到未解决状态时清空解决时间（解决方案保留供参考）。
 * - 处理期限已过且未解决的为逾期。
 * - 可见范围、编辑与删除权限与其他业务记录一致（销售只看、只改自己负责的）；客户必须可见。
 * - 新建、修改、删除写审计（描述、解决方案只记“已修改”）；指派给他人时通知新负责人。
 * Service tickets (cf. Zoho Cases): an account's questions, problems and requests from open through in progress and
 * waiting on the customer to resolved and closed. A ticket belongs to an account and optionally one of its contacts;
 * CS-year-sequence numbers come from an atomic counter and are never reused. Resolving or closing requires a
 * resolution and records the resolved time; reopening clears the time (the resolution stays for reference). Open
 * tickets past their due time are overdue. Visibility and edit/delete rights match other records; the account must
 * be visible. Changes are audited (long text as changed only); assigning to someone else notifies them.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { TicketChannel, TicketPriority, TicketStatus, TicketType } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, requirePermission, visible } from '../permissions';
import { containsText, listQuery, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';
import { notifyAssigned } from './notifications';
import { activePolicy, slaDue, sweepEscalations } from './ticket-sla';

/** 已解决类状态 / resolved-like statuses */
export const DONE_STATUSES: TicketStatus[] = [TicketStatus.RESOLVED, TicketStatus.CLOSED];
/** 未解决状态 / open statuses */
export const OPEN_STATUSES: TicketStatus[] = [TicketStatus.OPEN, TicketStatus.IN_PROGRESS, TicketStatus.WAITING_CUSTOMER];

const dueAt = z.iso
  .datetime({ offset: true })
  .nullish()
  .transform((v) => (v ? new Date(v) : v === null ? null : undefined));

const fields = {
  subject: requiredText(200),
  description: optionalText(10000),
  accountId: z.uuid(),
  contactId: optionalUuid,
  ownerId: z.uuid().nullish(),
  status: z.enum(TicketStatus).default(TicketStatus.OPEN),
  priority: z.enum(TicketPriority).default(TicketPriority.MEDIUM),
  type: z.enum(TicketType).default(TicketType.QUESTION),
  channel: z.enum(TicketChannel).default(TicketChannel.PHONE),
  dueAt,
  resolution: optionalText(10000),
};

/** 新建工单 / Create a ticket */
export const ticketCreateSchema = z.strictObject(fields);
/** 修改工单（含状态变化）/ Update a ticket (status changes included) */
export const ticketUpdateSchema = z
  .strictObject({ ...fields, status: z.enum(TicketStatus), priority: z.enum(TicketPriority), type: z.enum(TicketType), channel: z.enum(TicketChannel) })
  .partial();
/** 列表查询 / List query */
export const ticketListSchema = listQuery.extend({
  /** open = 全部未解决 / every open status */
  status: z.union([z.enum(TicketStatus), z.literal('open')]).optional(),
  priority: z.enum(TicketPriority).optional(),
  ownerId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  overdue: z.enum(['true']).optional(),
  /** 只看已升级（未解决）/ escalated and unresolved only */
  escalated: z.enum(['true']).optional(),
});

const include = {
  account: { select: { id: true, name: true } },
  contact: { select: { id: true, name: true, phone: true, email: true } },
  owner: { select: { id: true, name: true } },
} satisfies Prisma.TicketInclude;

/**
 * 给工单附加是否逾期。
 * Attach the overdue flag.
 */
const withOverdue = <T extends { status: TicketStatus; dueAt: Date | null }>(t: T, now = new Date()) => ({
  ...t,
  overdue: !!t.dueAt && t.dueAt < now && OPEN_STATUSES.includes(t.status),
});

/**
 * 原子分配下一个工单号（与新建同一事务）。
 * Allocate the next ticket number atomically (same transaction as the insert).
 */
export async function nextNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO ticket_counters (organization_id, year, last) VALUES (${organizationId}::uuid, ${year}, 1)
    ON CONFLICT (organization_id, year) DO UPDATE SET last = ticket_counters.last + 1
    RETURNING last`;
  return `CS-${year}-${String(rows[0]!.last).padStart(4, '0')}`;
}

/**
 * 校验客户可见、联系人属于该客户。
 * Check the account is visible and the contact belongs to it.
 */
async function assertParties(ctx: AuthContext, accountId: string, contactId: string | null | undefined) {
  const account = await prisma.account.count({ where: { id: accountId, ...visible(ctx) } });
  if (!account) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid account', { accountId: ['not_found'] });
  if (contactId) {
    const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId: ctx.organizationId }, select: { accountId: true } });
    if (!contact) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid contact', { contactId: ['not_found'] });
    if (contact.accountId !== accountId) throw new ApiError(400, 'VALIDATION_ERROR', 'Contact belongs to another account', { contactId: ['other_account'] });
  }
}

/**
 * 解决类状态需要解决方案；计算解决时间。
 * Resolved-like statuses need a resolution; compute the resolved time.
 */
function resolvedAtFor(status: TicketStatus, resolution: string | null | undefined, previous: Date | null): Date | null {
  if (!DONE_STATUSES.includes(status)) return null;
  if (!resolution) throw new ApiError(400, 'VALIDATION_ERROR', 'Resolution required', { resolution: ['required'] });
  return previous ?? new Date();
}

/**
 * 列表条件（列表与导出共用）。
 * List filter (shared by the list and the export).
 */
export function ticketWhere(ctx: AuthContext, query: z.infer<typeof ticketListSchema>): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = { AND: [visible(ctx), { organizationId: ctx.organizationId }] };
  const and = where.AND as Prisma.TicketWhereInput[];
  if (query.status === 'open') and.push({ status: { in: OPEN_STATUSES } });
  else if (query.status) and.push({ status: query.status });
  if (query.priority) and.push({ priority: query.priority });
  if (query.ownerId) and.push({ ownerId: query.ownerId });
  if (query.accountId) and.push({ accountId: query.accountId });
  if (query.overdue) and.push({ status: { in: OPEN_STATUSES }, dueAt: { lt: new Date() } });
  if (query.escalated) and.push({ status: { in: OPEN_STATUSES }, escalatedAt: { not: null } });
  if (query.q) {
    const c = containsText(query.q);
    and.push({ OR: [{ ticketNumber: c }, { subject: c }, { account: { name: c } }, { contact: { name: c } }] });
  }
  return where;
}

/**
 * 分页搜索工单（工单号、主题、客户、联系人），最新在前；附各状态数量（不含状态筛选）。
 * Search tickets (number, subject, account, contact), newest first, with per-status counts (ignoring the status filter).
 */
export async function listTickets(ctx: AuthContext, query: z.infer<typeof ticketListSchema>): Promise<Page<unknown> & { counts: Record<string, number> }> {
  await sweepEscalations(ctx.organizationId);
  const where = ticketWhere(ctx, query);
  const [items, total, byStatus] = await prisma.$transaction([
    prisma.ticket.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.ticket.count({ where }),
    prisma.ticket.groupBy({ by: ['status'], where: ticketWhere(ctx, { ...query, status: undefined }), _count: { _all: true }, orderBy: { status: 'asc' } }),
  ]);
  const now = new Date();
  const counts = Object.fromEntries(Object.values(TicketStatus).map((s) => [s, 0])) as Record<string, number>;
  for (const r of byStatus) counts[r.status] = (r._count as { _all: number })._all;
  return { items: items.map((t) => withOverdue(t, now)), total, page: query.page, pageSize: query.pageSize, counts };
}

/**
 * 工单详情；不可见 404。
 * Ticket detail; 404 when not visible.
 */
export async function getTicket(ctx: AuthContext, id: string) {
  await sweepEscalations(ctx.organizationId);
  const ticket = await prisma.ticket.findFirst({ where: { id, ...visible(ctx) }, include });
  if (!ticket) throw notFound();
  return withOverdue(ticket);
}

/**
 * 新建工单（负责人默认为自己）。
 * Create a ticket (owner defaults to the caller).
 */
export async function createTicket(ctx: AuthContext, input: z.infer<typeof ticketCreateSchema>) {
  requirePermission(ctx, 'record.create');
  const { ownerId, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  await assertParties(ctx, data.accountId, data.contactId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  const resolvedAt = resolvedAtFor(data.status, data.resolution, null);
  // 未填处理期限且启用 SLA 时按优先级自动计算 / without a due time, the SLA (if enabled) sets one from the priority
  const policy = data.dueAt === undefined ? await activePolicy(prisma, ctx.organizationId) : null;
  const dueAt = policy ? slaDue(policy, data.priority, new Date()) : (data.dueAt ?? null);
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.create({
      data: { ...data, dueAt, dueAuto: !!policy, organizationId: ctx.organizationId, ownerId: owner, resolvedAt, ticketNumber: await nextNumber(tx, ctx.organizationId) },
      include,
    });
    await audit(tx, { ...by(ctx), action: 'ticket.create', entityType: 'ticket', entityId: ticket.id, changes: { after: snapshot('ticket', ticket) } });
    await notifyAssigned(tx, ctx, { entity: 'ticket', id: ticket.id }, `${ticket.ticketNumber} ${ticket.subject}`, ticket.ownerId, null);
    return withOverdue(ticket);
  });
}

/**
 * 修改工单（含状态流转、改派）。换客户时原联系人若不属于新客户则需一并修改。
 * Update a ticket (status changes and reassignment included). When the account changes the contact must match it.
 */
export async function updateTicket(ctx: AuthContext, id: string, input: z.infer<typeof ticketUpdateSchema>) {
  const current = await getTicket(ctx, id);
  assertCanUpdate(ctx, current);
  const { ownerId, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  const accountId = data.accountId ?? current.accountId;
  const contactId = data.contactId !== undefined ? data.contactId : current.contactId;
  if (data.accountId !== undefined || data.contactId !== undefined) await assertParties(ctx, accountId, contactId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  const status = data.status ?? current.status;
  const resolution = data.resolution !== undefined ? data.resolution : current.resolution;
  const resolvedAt = resolvedAtFor(status, resolution, DONE_STATUSES.includes(current.status) ? current.resolvedAt : null);
  // 处理期限：手动填写则不再自动；自动期限随优先级重算；期限移到未来时清除升级标记以便再次升级
  // due time: a hand-set one stops being automatic; an automatic one follows the priority; moving it into the future clears the escalation
  const sla: { dueAt?: Date | null; dueAuto?: boolean; escalatedAt?: null } = {};
  if (data.dueAt !== undefined) {
    sla.dueAuto = false;
  } else if (data.priority && data.priority !== current.priority && current.dueAuto) {
    const policy = await activePolicy(prisma, ctx.organizationId);
    if (policy) sla.dueAt = slaDue(policy, data.priority, current.createdAt);
  }
  const nextDue = sla.dueAt !== undefined ? sla.dueAt : data.dueAt;
  if (nextDue !== undefined && current.escalatedAt && (!nextDue || nextDue > new Date())) sla.escalatedAt = null;
  return prisma.$transaction(async (tx) => {
    // 乐观并发：只在 updatedAt 未变时写入 / optimistic concurrency: write only if updatedAt is unchanged
    const { count } = await tx.ticket.updateMany({
      where: { id, organizationId: ctx.organizationId, updatedAt: current.updatedAt },
      data: { ...data, ...sla, ownerId: owner, resolvedAt },
    });
    if (!count) throw new ApiError(409, 'CONFLICT', 'Ticket was changed by someone else', { ticket: ['stale'] });
    const ticket = await tx.ticket.findUniqueOrThrow({ where: { id }, include });
    const fields = diff('ticket', current, ticket);
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'ticket.update', entityType: 'ticket', entityId: id, changes: { fields } });
    await notifyAssigned(tx, ctx, { entity: 'ticket', id }, `${ticket.ticketNumber} ${ticket.subject}`, ticket.ownerId, current.ownerId);
    return withOverdue(ticket);
  });
}

/**
 * 删除工单（需删除权限；工单号不复用）。
 * Delete a ticket (delete permission; the number is never reused).
 */
export async function deleteTicket(ctx: AuthContext, id: string): Promise<void> {
  assertCanDelete(ctx);
  const current = await getTicket(ctx, id);
  await prisma.$transaction(async (tx) => {
    // 评论随工单级联删除，记录数量 / comments cascade with the ticket; record how many
    const comments = await tx.ticketComment.count({ where: { organizationId: ctx.organizationId, ticketId: id } });
    const { count } = await tx.ticket.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (!count) throw notFound();
    await audit(tx, { ...by(ctx), action: 'ticket.delete', entityType: 'ticket', entityId: id, changes: { before: snapshot('ticket', current), cascadedComments: comments } });
  });
}
