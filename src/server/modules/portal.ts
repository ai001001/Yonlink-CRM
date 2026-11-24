/**
 * 客户门户（对标 Zoho Portals）：联系人登录门户，查看并提交自己的服务工单、回复工单，查看所属客户的报价单与发票。
 * 员工侧：
 * - 门户设置（portal.manage：管理员、经理）：启用/关闭、欢迎语；首次启用时生成随机门户标识（门户登录地址的一部分）。
 *   关闭后所有门户会话立即失效（每个请求都检查）。
 * - 开通联系人：联系人须可见且有邮箱；同一组织内门户邮箱不重复；生成一次性邀请链接（7 天，只返回一次）。
 *   已启用的用户再次邀请即重设密码；停用会清除邀请并结束其全部会话。写审计（不记录令牌）。
 * 客户侧（只读取会话中的组织、联系人、客户）：
 * - 工单：只看到自己提交或作为联系人的工单；新建工单渠道为“门户”、负责人为客户负责人（启用时）、按 SLA 计算期限并通知负责人。
 * - 回复：只看到公开评论（内部备注不显示）；已关闭的工单不能回复；已解决或等待客户的工单收到回复后重新打开；通知负责人。
 * - 报价单与发票：所属客户的已发送/已接受/已拒绝报价单与未作废发票（只读）。
 * Customer portal (cf. Zoho Portals): contacts sign in to view and raise their own service tickets, reply to them and
 * view their account's quotes and invoices. Staff (portal.manage: admins, managers) enable the portal and set a welcome
 * text (a random portal key is generated on first enable; turning it off ends every portal session at once) and give
 * visible contacts with an email access through one-time invitation links (7 days, shown once); portal emails are
 * unique per organization; re-inviting an active user resets the password; disabling clears the invitation and ends
 * all sessions; audited without tokens. Customers (organization, contact and account from the session only) see the
 * tickets they are the contact of, raise tickets (channel portal, owned by the account owner when active, SLA due time,
 * owner notified), see public comments only, cannot reply to closed tickets, reopen resolved or waiting tickets by
 * replying (owner notified), and read their account's sent/accepted/rejected quotes and non-void invoices.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { InvoiceStatus, NotificationType, PortalUserStatus, QuoteStatus, TicketChannel, TicketStatus, TicketType } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { hashToken } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { PORTAL_INVITE_TTL_MS, type PortalContext } from '../portal-auth';
import { optionalText, requiredText } from '../validation';
import { getContact } from './accounts';
import { activePolicy, slaDue } from './ticket-sla';
import { nextNumber } from './tickets';
import { runWorkflows } from './workflows';

/** 门户设置 / portal settings */
export const portalSettingsSchema = z.strictObject({ isEnabled: z.boolean(), welcome: optionalText(500) }).partial();
/** 门户新建工单 / portal ticket */
export const portalTicketSchema = z.strictObject({ subject: requiredText(200), description: optionalText(5000), type: z.enum(TicketType).default(TicketType.QUESTION) });
/** 门户回复 / portal reply */
export const portalCommentSchema = z.strictObject({ body: requiredText(5000) });

/** 新的门户标识 / a new portal key */
const newKey = () => randomBytes(16).toString('base64url').slice(0, 22);

// ———————————— 员工侧 / staff side ————————————

/**
 * 门户设置与门户用户数量。
 * Portal settings and portal user counts.
 */
export async function getPortalSettings(ctx: AuthContext) {
  requirePermission(ctx, 'portal.manage');
  const [settings, counts] = await Promise.all([
    prisma.portalSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
    prisma.portalUser.groupBy({ by: ['status'], where: { organizationId: ctx.organizationId }, _count: { _all: true } }),
  ]);
  const count = (s: PortalUserStatus) => counts.find((c) => c.status === s)?._count._all ?? 0;
  return {
    isEnabled: settings?.isEnabled ?? false,
    portalKey: settings?.portalKey ?? null,
    welcome: settings?.welcome ?? null,
    counts: { invited: count(PortalUserStatus.INVITED), active: count(PortalUserStatus.ACTIVE), disabled: count(PortalUserStatus.DISABLED) },
  };
}

/**
 * 修改门户设置（首次启用时生成门户标识）。
 * Update portal settings (the portal key is created on first enable).
 */
export async function updatePortalSettings(ctx: AuthContext, input: z.infer<typeof portalSettingsSchema>) {
  requirePermission(ctx, 'portal.manage');
  const org = ctx.organizationId;
  await prisma.$transaction(async (tx) => {
    const before = await tx.portalSettings.findUnique({ where: { organizationId: org } });
    const after = await tx.portalSettings.upsert({
      where: { organizationId: org },
      create: { organizationId: org, portalKey: newKey(), isEnabled: input.isEnabled ?? false, welcome: input.welcome ?? null },
      update: { isEnabled: input.isEnabled, welcome: input.welcome },
    });
    const fields = Object.fromEntries((['isEnabled', 'welcome'] as const).filter((k) => (before?.[k] ?? null) !== after[k]).map((k) => [k, [before?.[k] ?? null, after[k]]]));
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'portal.settings', entityType: 'portal', entityId: null, changes: { fields } });
  });
  return getPortalSettings(ctx);
}

/** 门户用户的员工视图 / staff view of a portal user */
const staffView = (u: { status: PortalUserStatus; email: string; lastLoginAt: Date | null; inviteExpiresAt: Date | null; createdAt: Date } | null) =>
  u && { status: u.status, email: u.email, lastLoginAt: u.lastLoginAt, inviteExpiresAt: u.inviteExpiresAt, createdAt: u.createdAt };

/**
 * 联系人的门户开通状态（联系人须可见）。
 * A contact's portal access (the contact must be visible).
 */
export async function getContactPortal(ctx: AuthContext, contactId: string) {
  requirePermission(ctx, 'portal.manage');
  await getContact(ctx, contactId);
  return { portal: staffView(await prisma.portalUser.findUnique({ where: { organizationId_contactId: { organizationId: ctx.organizationId, contactId } } })) };
}

/**
 * 为联系人生成邀请链接（开通、重新邀请或重设密码）；原始令牌只返回这一次。
 * Create an invitation for a contact (grant, re-invite or reset the password); the raw token is returned only now.
 */
export async function invitePortal(ctx: AuthContext, contactId: string) {
  requirePermission(ctx, 'portal.manage');
  const org = ctx.organizationId;
  const contact = await getContact(ctx, contactId);
  const email = contact.email?.trim().toLowerCase();
  if (!email) throw new ApiError(400, 'VALIDATION_ERROR', 'The contact has no email', { email: ['required'] });
  const settings = await prisma.portalSettings.findUnique({ where: { organizationId: org } });
  if (!settings?.isEnabled) throw new ApiError(409, 'CONFLICT', 'The portal is disabled', { portal: ['disabled'] });
  const token = randomBytes(32).toString('base64url');
  const inviteExpiresAt = new Date(Date.now() + PORTAL_INVITE_TTL_MS);
  try {
    const user = await prisma.$transaction(async (tx) => {
      const current = await tx.portalUser.findUnique({ where: { organizationId_contactId: { organizationId: org, contactId } } });
      const data = { email, inviteTokenHash: hashToken(token), inviteExpiresAt };
      const u = current
        ? await tx.portalUser.update({ where: { id: current.id }, data: { ...data, status: current.status === PortalUserStatus.ACTIVE ? PortalUserStatus.ACTIVE : PortalUserStatus.INVITED, invitedById: ctx.userId } })
        : await tx.portalUser.create({ data: { ...data, organizationId: org, contactId, invitedById: ctx.userId } });
      await audit(tx, { ...by(ctx), action: 'portal.invite', entityType: 'portal', entityId: u.id, changes: { contactId, contact: contact.name, reset: current?.status === PortalUserStatus.ACTIVE } });
      return u;
    });
    return { token, inviteExpiresAt, portalKey: settings.portalKey, portal: staffView(user) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Email already used by another portal user', { email: ['taken'] });
    throw err;
  }
}

/**
 * 停用联系人的门户（清除邀请、结束全部会话）。
 * Disable a contact's portal access (clear the invitation and end all sessions).
 */
export async function disablePortal(ctx: AuthContext, contactId: string) {
  requirePermission(ctx, 'portal.manage');
  const contact = await getContact(ctx, contactId);
  const user = await prisma.portalUser.findUnique({ where: { organizationId_contactId: { organizationId: ctx.organizationId, contactId } } });
  if (!user) throw notFound();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.portalUser.update({ where: { id: user.id }, data: { status: PortalUserStatus.DISABLED, inviteTokenHash: null, inviteExpiresAt: null } });
    const { count } = await tx.portalSession.deleteMany({ where: { portalUserId: user.id } });
    await audit(tx, { ...by(ctx), action: 'portal.disable', entityType: 'portal', entityId: user.id, changes: { contactId, contact: contact.name, sessions: count } });
    return u;
  });
  return { portal: staffView(updated) };
}

// ———————————— 客户侧 / customer side ————————————

/**
 * 门户首页信息。
 * Portal home information.
 */
export async function portalMe(ctx: PortalContext) {
  const [account, org, settings] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: ctx.accountId }, select: { name: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { name: true } }),
    prisma.portalSettings.findUniqueOrThrow({ where: { organizationId: ctx.organizationId }, select: { welcome: true } }),
  ]);
  return { name: ctx.name, email: ctx.email, account: account.name, organization: org.name, welcome: settings.welcome };
}

const ticketSelect = { id: true, ticketNumber: true, subject: true, description: true, status: true, priority: true, type: true, resolution: true, createdAt: true, updatedAt: true, resolvedAt: true } satisfies Prisma.TicketSelect;
/** 自己的工单 / own tickets */
const myTickets = (ctx: PortalContext): Prisma.TicketWhereInput => ({ organizationId: ctx.organizationId, contactId: ctx.contactId });

/**
 * 自己的工单（最新在前）。
 * Own tickets, newest first.
 */
export async function listMyTickets(ctx: PortalContext) {
  return { items: await prisma.ticket.findMany({ where: myTickets(ctx), select: ticketSelect, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 200 }) };
}

/** 客户负责人（启用时）/ the account owner when active */
async function accountOwner(tx: Prisma.TransactionClient, ctx: PortalContext): Promise<string | null> {
  const account = await tx.account.findUniqueOrThrow({ where: { id: ctx.accountId }, select: { owner: { select: { id: true, isActive: true } } } });
  return account.owner?.isActive ? account.owner.id : null;
}

/**
 * 在门户中新建工单。
 * Raise a ticket from the portal.
 */
export async function createMyTicket(ctx: PortalContext, input: z.infer<typeof portalTicketSchema>) {
  const policy = await activePolicy(prisma, ctx.organizationId);
  return prisma.$transaction(async (tx) => {
    const owner = await accountOwner(tx, ctx);
    const ticket = await tx.ticket.create({
      data: {
        organizationId: ctx.organizationId,
        ticketNumber: await nextNumber(tx, ctx.organizationId),
        subject: input.subject,
        description: input.description ?? null,
        type: input.type,
        accountId: ctx.accountId,
        contactId: ctx.contactId,
        ownerId: owner,
        channel: TicketChannel.PORTAL,
        dueAt: policy ? slaDue(policy, 'MEDIUM', new Date()) : null,
        dueAuto: !!policy,
      },
      select: ticketSelect,
    });
    await audit(tx, { organizationId: ctx.organizationId, actorId: null, action: 'ticket.create', entityType: 'ticket', entityId: ticket.id, changes: { via: 'portal', portalUserId: ctx.portalUserId, contact: ctx.name, after: { ticketNumber: ticket.ticketNumber, subject: ticket.subject } }, meta: ctx.meta });
    if (owner) await tx.notification.create({ data: { organizationId: ctx.organizationId, userId: owner, type: NotificationType.ASSIGNED, actorId: null, ticketId: ticket.id, title: `${ticket.ticketNumber} ${ticket.subject}`.slice(0, 200) } });
    // 客户在门户新建的工单也触发工作流（没有操作人）/ portal tickets fire workflows too (no actor)
    const full = await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    if (await runWorkflows(tx, { entity: 'TICKET', before: null, after: { ...full, name: `${full.ticketNumber} ${full.subject}` }, actorId: null })) {
      return tx.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: ticketSelect });
    }
    return ticket;
  });
}

/**
 * 自己的工单详情（只含公开评论）。
 * Own ticket detail (public comments only).
 */
export async function getMyTicket(ctx: PortalContext, id: string) {
  const ticket = await prisma.ticket.findFirst({ where: { id, ...myTickets(ctx) }, select: ticketSelect });
  if (!ticket) throw notFound();
  const comments = await prisma.ticketComment.findMany({
    where: { organizationId: ctx.organizationId, ticketId: id, isInternal: false },
    select: { id: true, body: true, createdAt: true, author: { select: { name: true } }, portalUserId: true, portalUser: { select: { contact: { select: { name: true } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return {
    ...ticket,
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      // 员工回复显示姓名；客户回复标记是否为自己 / staff replies show the name; customer replies say whether they are mine
      author: c.author ? { kind: 'staff' as const, name: c.author.name } : { kind: 'customer' as const, name: c.portalUser?.contact.name ?? null, mine: c.portalUserId === ctx.portalUserId },
    })),
  };
}

/**
 * 在门户中回复工单；已解决或等待客户的工单重新打开。
 * Reply from the portal; resolved or waiting tickets reopen.
 */
export async function addMyComment(ctx: PortalContext, id: string, input: z.infer<typeof portalCommentSchema>) {
  const ticket = await prisma.ticket.findFirst({ where: { id, ...myTickets(ctx) }, select: { id: true, status: true, ownerId: true, ticketNumber: true, subject: true } });
  if (!ticket) throw notFound();
  if (ticket.status === TicketStatus.CLOSED) throw new ApiError(409, 'CONFLICT', 'The ticket is closed', { ticket: ['closed'] });
  return prisma.$transaction(async (tx) => {
    const comment = await tx.ticketComment.create({ data: { organizationId: ctx.organizationId, ticketId: id, portalUserId: ctx.portalUserId, body: input.body, isInternal: false }, select: { id: true, body: true, createdAt: true } });
    const reopen = ticket.status === TicketStatus.RESOLVED || ticket.status === TicketStatus.WAITING_CUSTOMER;
    if (reopen) await tx.ticket.update({ where: { id }, data: { status: TicketStatus.OPEN, resolvedAt: null } });
    await audit(tx, {
      organizationId: ctx.organizationId,
      actorId: null,
      action: 'ticket.comment',
      entityType: 'ticket',
      entityId: id,
      changes: { via: 'portal', portalUserId: ctx.portalUserId, commentId: comment.id, isInternal: false, length: comment.body.length, ...(reopen ? { reopened: [ticket.status, TicketStatus.OPEN] } : {}) },
      meta: ctx.meta,
    });
    const owner = ticket.ownerId ? await tx.user.findFirst({ where: { id: ticket.ownerId, isActive: true }, select: { id: true } }) : null;
    if (owner) await tx.notification.create({ data: { organizationId: ctx.organizationId, userId: owner.id, type: NotificationType.TICKET_COMMENT, actorId: null, ticketId: id, title: `${ticket.ticketNumber} ${ticket.subject}`.slice(0, 200) } });
    return { ...comment, reopened: reopen };
  });
}

/**
 * 所属客户的报价单（不含草稿）。
 * The account's quotes (drafts excluded).
 */
export async function listMyQuotes(ctx: PortalContext) {
  const rows = await prisma.quote.findMany({
    where: { organizationId: ctx.organizationId, deal: { accountId: ctx.accountId }, status: { in: [QuoteStatus.SENT, QuoteStatus.ACCEPTED, QuoteStatus.REJECTED] } },
    select: { id: true, quoteNumber: true, subject: true, status: true, currency: true, total: true, validUntil: true, sentAt: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 200,
  });
  return { items: rows };
}

/**
 * 所属客户的发票（不含作废）。
 * The account's invoices (void excluded).
 */
export async function listMyInvoices(ctx: PortalContext) {
  const rows = await prisma.invoice.findMany({
    where: { organizationId: ctx.organizationId, deal: { accountId: ctx.accountId }, status: { not: InvoiceStatus.VOID } },
    select: { id: true, invoiceNumber: true, subject: true, status: true, currency: true, total: true, paidAmount: true, invoiceDate: true, dueDate: true },
    orderBy: [{ invoiceDate: 'desc' }, { id: 'asc' }],
    take: 200,
  });
  return { items: rows.map((r) => ({ ...r, balance: r.total.minus(r.paidAmount).toFixed(2) })) };
}
