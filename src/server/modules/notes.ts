/**
 * 备注应用服务（线索、客户、商机）。
 * - 查看：所属记录对当前用户可见即可查看其备注。
 * - 新增：需能编辑所属记录（只读用户不能新增）。
 * - 修改：仅作者本人。删除：作者本人或拥有删除权限的角色。
 * - 所有写操作与审计同事务；审计中备注正文脱敏。
 * Notes service (leads, accounts, deals): visible parent → readable; adding requires edit rights on the parent;
 * only the author edits; the author or roles with delete permission delete; audited with redacted content.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, can, visible } from '../permissions';

/** 备注正文 / Note content */
const content = z.string().trim().min(1).max(5000);
const parentIds = { leadId: z.uuid().optional(), accountId: z.uuid().optional(), dealId: z.uuid().optional() };

/** 恰好指定一个所属记录 / exactly one parent must be given */
const oneParent = (v: { leadId?: string; accountId?: string; dealId?: string }) => [v.leadId, v.accountId, v.dealId].filter(Boolean).length === 1;

/** 列表查询 / List query */
export const noteListSchema = z.object(parentIds).refine(oneParent, { message: 'Exactly one of leadId, accountId, dealId is required', path: ['parent'] });
/** 新建备注 / Create note */
export const noteCreateSchema = z.strictObject({ content, ...parentIds }).refine(oneParent, { message: 'Exactly one of leadId, accountId, dealId is required', path: ['parent'] });
/** 修改备注 / Update note */
export const noteUpdateSchema = z.strictObject({ content });

const include = { author: { select: { id: true, name: true } } } satisfies Prisma.NoteInclude;

type Parent = { leadId?: string | null; accountId?: string | null; dealId?: string | null };

/**
 * 读取对当前用户可见的所属记录（返回负责人，用于编辑权限判断），不可见时 404。
 * Load the parent record if visible (returns its owner for edit checks); 404 otherwise.
 */
async function requireParent(ctx: AuthContext, p: Parent): Promise<{ ownerId: string | null }> {
  const scope = visible(ctx);
  const select = { ownerId: true };
  const row = p.leadId
    ? await prisma.lead.findFirst({ where: { id: p.leadId, ...scope }, select })
    : p.accountId
      ? await prisma.account.findFirst({ where: { id: p.accountId, ...scope }, select })
      : p.dealId
        ? await prisma.deal.findFirst({ where: { id: p.dealId, ...scope }, select })
        : null;
  if (!row) throw notFound();
  return row;
}

/**
 * 读取备注（其所属记录必须可见），不可见或不存在时 404。
 * Load a note whose parent is visible; 404 otherwise.
 */
async function requireNote(ctx: AuthContext, id: string) {
  const scope = visible(ctx);
  const note = await prisma.note.findFirst({
    where: { id, organizationId: ctx.organizationId, OR: [{ lead: scope }, { account: scope }, { deal: scope }] },
    include,
  });
  if (!note) throw notFound();
  return note;
}

/**
 * 某条记录的备注（最新在前，最多 200 条）。
 * Notes of a record, newest first (up to 200).
 */
export async function listNotes(ctx: AuthContext, query: z.infer<typeof noteListSchema>) {
  await requireParent(ctx, query);
  const items = await prisma.note.findMany({
    where: { organizationId: ctx.organizationId, leadId: query.leadId, accountId: query.accountId, dealId: query.dealId },
    include,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 200,
  });
  return { items };
}

/**
 * 新增备注：需能编辑所属记录。
 * Add a note; requires edit rights on the parent.
 */
export async function createNote(ctx: AuthContext, input: z.infer<typeof noteCreateSchema>) {
  assertCanUpdate(ctx, await requireParent(ctx, input));
  return prisma.$transaction(async (tx) => {
    const note = await tx.note.create({
      data: {
        organizationId: ctx.organizationId,
        authorId: ctx.userId,
        content: input.content,
        leadId: input.leadId ?? null,
        accountId: input.accountId ?? null,
        dealId: input.dealId ?? null,
      },
      include,
    });
    await audit(tx, { ...by(ctx), action: 'note.create', entityType: 'note', entityId: note.id, changes: { after: snapshot('note', note) } });
    return note;
  });
}

/**
 * 修改备注：仅作者本人。
 * Edit a note; author only.
 */
export async function updateNote(ctx: AuthContext, id: string, input: z.infer<typeof noteUpdateSchema>) {
  const current = await requireNote(ctx, id);
  if (current.authorId !== ctx.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the author can edit a note', { note: ['author_only'] });
  return prisma.$transaction(async (tx) => {
    // 只有内容真正改变时才记录编辑时间 / editedAt only changes when the content actually changes
    const changed = input.content !== current.content;
    const note = await tx.note.update({ where: { id }, data: changed ? { content: input.content, editedAt: new Date() } : {}, include });
    if (changed) {
      await audit(tx, { ...by(ctx), action: 'note.update', entityType: 'note', entityId: id, changes: { fields: { content: ['[redacted]', '[redacted]'] } } });
    }
    return note;
  });
}

/**
 * 删除备注：作者本人或拥有删除权限的角色。
 * Delete a note; the author or roles with delete permission.
 */
export async function deleteNote(ctx: AuthContext, id: string): Promise<void> {
  const note = await requireNote(ctx, id);
  if (note.authorId !== ctx.userId && !can(ctx, 'record.delete')) throw new ApiError(403, 'FORBIDDEN', 'Permission denied', { note: ['author_or_delete'] });
  await prisma.$transaction(async (tx) => {
    await tx.note.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'note.delete', entityType: 'note', entityId: id, changes: { before: snapshot('note', note) } });
  });
}
