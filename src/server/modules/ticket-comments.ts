/**
 * 工单评论（处理往来）：对外回复（已告知客户）与内部备注。
 * - 查看需能看到工单；发表需能编辑工单（负责人本人、经理、管理员）。
 * - 作者可修改、删除自己的评论（修改记录编辑时间）；有 record.update.all 的用户（管理员、经理）可删除任何评论。
 * - 发表、修改、删除写审计（内容只记“已修改”与字数）；他人在我负责的工单上发表评论时通知我。
 * - 评论不改变工单的 updatedAt，不会让他人正在编辑的工单产生版本冲突。
 * Ticket comments: external replies (already told to the customer) and internal notes. Viewing needs the ticket to
 * be visible; posting needs edit rights on it. Authors edit or delete their own (edits are timestamped); users with
 * record.update.all delete any. Changes are audited (content redacted, length kept); the owner is notified of other
 * people's comments. Comments do not touch the ticket's updatedAt, so they never cause edit conflicts.
 */
import { z } from 'zod';
import { audit, by, REDACTED } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, can, visible } from '../permissions';
import { notifyTicketComment } from './notifications';

const body = z.string().trim().min(1).max(5000);

/** 发表评论 / Post a comment */
export const commentCreateSchema = z.strictObject({ body, isInternal: z.boolean().default(false) });
/** 修改评论 / Edit a comment */
export const commentUpdateSchema = z
  .strictObject({ body, isInternal: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'No changes');

// 客户在门户中的回复没有员工作者，带门户用户（联系人姓名）/ portal replies have no staff author but a portal user (contact name)
const select = { id: true, ticketId: true, body: true, isInternal: true, editedAt: true, createdAt: true, author: { select: { id: true, name: true } }, portalUser: { select: { contact: { select: { name: true } } } } } as const;

/**
 * 读取可见工单。
 * Load a visible ticket.
 */
async function requireTicket(ctx: AuthContext, ticketId: string) {
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, ...visible(ctx) }, select: { id: true, ownerId: true, ticketNumber: true, subject: true } });
  if (!ticket) throw notFound();
  return ticket;
}

/**
 * 工单的评论（按时间先后）。
 * Comments of a ticket, oldest first.
 */
export async function listComments(ctx: AuthContext, ticketId: string) {
  await requireTicket(ctx, ticketId);
  const items = await prisma.ticketComment.findMany({ where: { organizationId: ctx.organizationId, ticketId }, select, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { items };
}

/**
 * 发表评论并通知负责人。
 * Post a comment and notify the owner.
 */
export async function addComment(ctx: AuthContext, ticketId: string, input: z.infer<typeof commentCreateSchema>) {
  const ticket = await requireTicket(ctx, ticketId);
  assertCanUpdate(ctx, ticket);
  return prisma.$transaction(async (tx) => {
    const comment = await tx.ticketComment.create({ data: { organizationId: ctx.organizationId, ticketId, authorId: ctx.userId, body: input.body, isInternal: input.isInternal }, select });
    await audit(tx, { ...by(ctx), action: 'ticket.comment', entityType: 'ticket', entityId: ticketId, changes: { commentId: comment.id, isInternal: comment.isInternal, length: comment.body.length } });
    await notifyTicketComment(tx, ctx, { id: ticketId, ownerId: ticket.ownerId, title: `${ticket.ticketNumber} ${ticket.subject}` });
    return comment;
  });
}

/**
 * 读取评论（所属工单必须可见）。
 * Load a comment whose ticket is visible.
 */
async function requireComment(ctx: AuthContext, id: string) {
  const comment = await prisma.ticketComment.findFirst({ where: { id, organizationId: ctx.organizationId, ticket: visible(ctx) }, select: { ...select, authorId: true } });
  if (!comment) throw notFound();
  return comment;
}

/**
 * 修改自己的评论。
 * Edit one's own comment.
 */
export async function updateComment(ctx: AuthContext, id: string, input: z.infer<typeof commentUpdateSchema>) {
  const current = await requireComment(ctx, id);
  if (current.authorId !== ctx.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the author can edit a comment', { comment: ['not_author'] });
  return prisma.$transaction(async (tx) => {
    const comment = await tx.ticketComment.update({ where: { id }, data: { ...input, editedAt: new Date() }, select });
    const fields: Record<string, [unknown, unknown]> = {};
    if (comment.body !== current.body) fields.body = [REDACTED, REDACTED];
    if (comment.isInternal !== current.isInternal) fields.isInternal = [current.isInternal, comment.isInternal];
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'ticket.comment_update', entityType: 'ticket', entityId: current.ticketId, changes: { commentId: id, fields } });
    }
    return comment;
  });
}

/**
 * 删除评论（作者本人，或可编辑全部记录的用户）。
 * Delete a comment (its author, or a user who may edit every record).
 */
export async function deleteComment(ctx: AuthContext, id: string): Promise<void> {
  const current = await requireComment(ctx, id);
  if (current.authorId !== ctx.userId && !can(ctx, 'record.update.all')) throw new ApiError(403, 'FORBIDDEN', 'Cannot delete this comment', { comment: ['not_author'] });
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.ticketComment.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (!count) throw notFound();
    await audit(tx, { ...by(ctx), action: 'ticket.comment_delete', entityType: 'ticket', entityId: current.ticketId, changes: { commentId: id, authorId: current.authorId, isInternal: current.isInternal, length: current.body.length } });
  });
}
