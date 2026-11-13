/**
 * 附件应用服务（线索、客户、商机）。
 * - 查看/下载：所属记录可见；上传：能编辑所属记录；删除：上传人（仍能编辑所属记录）或有删除权限的角色。
 * - 只允许白名单扩展名，并校验文件头特征（扩展名与内容不符拒绝）；不接受 HTML/SVG/脚本等可执行内容。
 * - 单个文件 ≤ 10 MB，每条记录 ≤ 50 个；保存 SHA-256；文件名去除路径与控制字符。
 * - 上传先写文件再写数据库（失败时删除文件）；删除先删数据库再删文件。上传与删除写审计（只记文件名与大小）。
 * Attachments for leads, accounts and deals: visibility for viewing/downloading, edit rights for uploading, uploader or
 * delete permission for removing; whitelisted extensions with magic-byte checks; ≤ 10 MB, ≤ 50 per record; SHA-256
 * stored; names sanitised; uploads and deletions audited (name and size only).
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, can, visible } from '../permissions';
import { loadFile, removeFile, saveFile } from '../storage';

/** 单个文件上限 / per-file limit */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 每条记录附件上限 / per-record limit */
export const MAX_ATTACHMENTS = 50;

/** 允许的类型：扩展名 → 内容类型与文件头校验 / allowed types: extension → content type and magic check */
const TYPES: Record<string, { type: string; check: (b: Uint8Array) => boolean }> = (() => {
  const starts = (sig: number[]) => (b: Uint8Array) => sig.every((v, i) => b[i] === v);
  const ascii = (s: string, at = 0) => (b: Uint8Array) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  const zip = starts([0x50, 0x4b, 0x03, 0x04]);
  const ole = starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  // 文本：前 8 KB 不含 NUL 字节 / text: no NUL byte in the first 8 KB
  const text = (b: Uint8Array) => !b.subarray(0, 8192).includes(0);
  return {
    pdf: { type: 'application/pdf', check: ascii('%PDF-') },
    png: { type: 'image/png', check: starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    jpg: { type: 'image/jpeg', check: starts([0xff, 0xd8, 0xff]) },
    jpeg: { type: 'image/jpeg', check: starts([0xff, 0xd8, 0xff]) },
    gif: { type: 'image/gif', check: (b) => ascii('GIF87a')(b) || ascii('GIF89a')(b) },
    webp: { type: 'image/webp', check: (b) => ascii('RIFF')(b) && ascii('WEBP', 8)(b) },
    zip: { type: 'application/zip', check: zip },
    docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: zip },
    xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: zip },
    pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: zip },
    doc: { type: 'application/msword', check: ole },
    xls: { type: 'application/vnd.ms-excel', check: ole },
    ppt: { type: 'application/vnd.ms-powerpoint', check: ole },
    txt: { type: 'text/plain', check: text },
    csv: { type: 'text/csv', check: text },
  };
})();
/** 允许的扩展名（界面提示用）/ allowed extensions (for the UI hint) */
export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

/** 所属记录：恰好一个 / parent: exactly one */
export const attachmentParentSchema = z
  .strictObject({ leadId: z.uuid().optional(), accountId: z.uuid().optional(), dealId: z.uuid().optional() })
  .refine((v) => [v.leadId, v.accountId, v.dealId].filter(Boolean).length === 1, { message: 'Exactly one parent is required', path: ['parent'] });
type Parent = z.infer<typeof attachmentParentSchema>;

/**
 * 规范化文件名：去掉路径部分与控制字符，限制 200 字（保留扩展名）。
 * Sanitise a file name: drop path parts and control characters, cap at 200 chars (keeping the extension).
 */
export function cleanFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (base.length <= 200) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return base.slice(0, 200 - ext.length) + ext;
}

/**
 * 根据文件名与内容判定类型；不允许或内容不符时 400。
 * Detect the type from name and content; 400 when not allowed or mismatched.
 */
export function detectType(fileName: string, data: Uint8Array): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const t = TYPES[ext];
  if (!t) throw new ApiError(400, 'VALIDATION_ERROR', 'File type not allowed', { file: ['type_not_allowed'] });
  if (!t.check(data)) throw new ApiError(400, 'VALIDATION_ERROR', 'File content does not match its type', { file: ['content_mismatch'] });
  return t.type;
}

const select = {
  id: true,
  fileName: true,
  contentType: true,
  size: true,
  createdAt: true,
  leadId: true,
  accountId: true,
  dealId: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttachmentSelect;

/**
 * 读取可见的所属记录（含负责人，用于编辑权限判断）。
 * Load the visible parent (with its owner for the edit check).
 */
async function requireParent(ctx: AuthContext, parent: Parent): Promise<{ ownerId: string | null }> {
  const where = { ...visible(ctx) };
  const sel = { ownerId: true } as const;
  const record = parent.leadId
    ? await prisma.lead.findFirst({ where: { ...where, id: parent.leadId }, select: sel })
    : parent.accountId
      ? await prisma.account.findFirst({ where: { ...where, id: parent.accountId }, select: sel })
      : await prisma.deal.findFirst({ where: { ...where, id: parent.dealId }, select: sel });
  if (!record) throw notFound();
  return record;
}

/**
 * 所属记录的附件（最新在前）。
 * Attachments of a record, newest first.
 */
export async function listAttachments(ctx: AuthContext, parent: Parent) {
  await requireParent(ctx, parent);
  const items = await prisma.attachment.findMany({
    where: { organizationId: ctx.organizationId, leadId: parent.leadId, accountId: parent.accountId, dealId: parent.dealId },
    select,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return { items, maxBytes: MAX_FILE_BYTES, extensions: ALLOWED_EXTENSIONS };
}

/**
 * 上传附件。
 * Upload an attachment.
 */
export async function uploadAttachment(ctx: AuthContext, parent: Parent, file: { name: string; data: Uint8Array }) {
  assertCanUpdate(ctx, await requireParent(ctx, parent));
  if (file.data.byteLength === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Empty file', { file: ['empty'] });
  if (file.data.byteLength > MAX_FILE_BYTES) throw new ApiError(413, 'VALIDATION_ERROR', 'File too large', { file: ['too_large'] });
  const fileName = cleanFileName(file.name);
  if (!fileName) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid file name', { file: ['name'] });
  const contentType = detectType(fileName, file.data);
  const where = { organizationId: ctx.organizationId, leadId: parent.leadId, accountId: parent.accountId, dealId: parent.dealId };
  if ((await prisma.attachment.count({ where })) >= MAX_ATTACHMENTS) throw new ApiError(400, 'VALIDATION_ERROR', 'Too many attachments', { file: ['limit'] });

  const id = randomUUID();
  const sha256 = createHash('sha256').update(file.data).digest('hex');
  await saveFile(ctx.organizationId, id, file.data);
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.attachment.create({
        data: { id, ...where, fileName, contentType, size: file.data.byteLength, sha256, uploadedById: ctx.userId },
        select,
      });
      await audit(tx, { ...by(ctx), action: 'attachment.create', entityType: 'attachment', entityId: id, changes: { after: snapshot('attachment', row) } });
      return row;
    });
  } catch (err) {
    // 数据库写入失败时删除已写入的文件 / remove the written file when the database write fails
    await removeFile(ctx.organizationId, id).catch(() => undefined);
    throw err;
  }
}

/**
 * 读取可见附件（所属记录可见），含所属记录负责人。
 * Load a visible attachment (its parent is visible), with the parent's owner.
 */
async function requireAttachment(ctx: AuthContext, id: string) {
  const v = visible(ctx);
  const row = await prisma.attachment.findFirst({
    where: { id, organizationId: ctx.organizationId, OR: [{ lead: v }, { account: v }, { deal: v }] },
    select: { ...select, uploadedById: true, sha256: true, lead: { select: { ownerId: true } }, account: { select: { ownerId: true } }, deal: { select: { ownerId: true } } },
  });
  if (!row) throw notFound();
  return { ...row, parentOwnerId: (row.lead ?? row.account ?? row.deal)?.ownerId ?? null };
}

/**
 * 下载附件：返回元数据与文件内容（校验 SHA-256，损坏时 500）。
 * Download: metadata and content (SHA-256 verified; 500 when corrupted).
 */
export async function downloadAttachment(ctx: AuthContext, id: string) {
  const row = await requireAttachment(ctx, id);
  const data = await loadFile(ctx.organizationId, row.id);
  if (createHash('sha256').update(data).digest('hex') !== row.sha256) throw new ApiError(500, 'INTERNAL_ERROR', 'Stored file is corrupted');
  return { fileName: row.fileName, contentType: row.contentType, data };
}

/**
 * 删除附件（上传人且仍能编辑所属记录，或有删除权限的角色）。
 * Delete an attachment (the uploader who can still edit the parent, or roles with delete permission).
 */
export async function deleteAttachment(ctx: AuthContext, id: string): Promise<void> {
  const row = await requireAttachment(ctx, id);
  if (!can(ctx, 'record.delete')) {
    if (row.uploadedById !== ctx.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the uploader can delete this attachment');
    assertCanUpdate(ctx, { ownerId: row.parentOwnerId });
  }
  await prisma.$transaction(async (tx) => {
    await tx.attachment.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'attachment.delete', entityType: 'attachment', entityId: id, changes: { before: snapshot('attachment', row) } });
  });
  await removeFile(ctx.organizationId, id);
}

/**
 * 生成 Content-Disposition（附件下载，含 UTF-8 文件名）。
 * Content-Disposition for a download with a UTF-8 file name.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
