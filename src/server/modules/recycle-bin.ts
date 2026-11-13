/**
 * 回收站（参考 Zoho Recycle Bin）：删除线索、客户、商机时，在同一事务内把记录及随之删除的附属数据保存为快照，
 * 原记录随后被真正删除（因此其他查询无需改动，已删除数据不会出现在任何列表、统计、搜索中）。
 * - 快照内容：记录本身；备注、标签、附件元数据（文件保留在磁盘，彻底删除或过期时才删除）、仅关联本记录的跟进（会随记录删除）；与其他记录共享、只解除关联的跟进 ID；
 *   客户的联系人与转化来源线索；商机的产品明细、报价单（含明细）与转化来源线索。
 * - 恢复：按原 ID 与时间写回；依赖的客户、产品必须仍存在（否则 409 并说明）；已不存在的关联（标签、共享跟进、转化线索、
 *   线索的转化目标）跳过。快照中的报价单号保留占用，不会被新报价单复用。
 * - 保留 30 天；访问回收站时清除过期条目并写审计。查看与恢复需删除权限，彻底删除需 recycle.purge（管理员）。
 * Recycle bin (cf. Zoho): deleting a lead, account or deal snapshots the record and the data deleted with it in the same
 * transaction; the rows are then really deleted, so no other query needs a filter. Restore writes the rows back with
 * their original ids and timestamps; required parents (account, products) must still exist (409 otherwise); vanished
 * optional links are skipped. Quote numbers in snapshots stay reserved. Entries expire after 30 days.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { removeFile } from '../storage';
import { containsText } from '../validation';

/** 保留天数 / retention in days */
export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** 回收对象 / recyclable entity */
export type RecycleEntity = 'lead' | 'account' | 'deal';
type Field = 'leadId' | 'accountId' | 'dealId';
const FIELD: Record<RecycleEntity, Field> = { lead: 'leadId', account: 'accountId', deal: 'dealId' };

/** 列表查询 / list query */
export const recycleListSchema = z.strictObject({
  entityType: z.enum(['lead', 'account', 'deal']).optional(),
  q: z.string().trim().max(100).optional(),
});

/** 快照结构 / snapshot payload */
interface Payload {
  version: 1;
  record: Record<string, unknown>;
  notes: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  /** 共享跟进：只解除了与本记录的关联 / shared activities that were only unlinked */
  detachedActivityIds: string[];
  tagIds: string[];
  /** 附件元数据（文件保留在磁盘，彻底删除时才删除）/ attachment metadata (files stay on disk until purged) */
  attachments?: Record<string, unknown>[];
  contacts?: Record<string, unknown>[];
  lineItems?: Record<string, unknown>[];
  quotes?: (Record<string, unknown> & { lines: Record<string, unknown>[] })[];
  /** 指向本记录（或其联系人）的转化来源线索 / leads whose conversion points at this record (or its contacts) */
  conversions: { leadId: string; field: 'convertedAccountId' | 'convertedContactId' | 'convertedDealId'; value: string }[];
}

/** 需要还原为 Date 的字段 / fields revived as Date */
const DATE_KEYS = new Set(['createdAt', 'updatedAt', 'completedAt', 'dueAt', 'convertedAt', 'editedAt', 'expectedCloseDate', 'validUntil', 'sentAt', 'decidedAt']);

/**
 * JSON 快照行 → 可写入的数据（还原日期，组织 ID 以当前上下文为准）。
 * Snapshot row → writable data (dates revived; the organization id always comes from the context).
 */
function revive<T>(row: Record<string, unknown>, organizationId: string): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = DATE_KEYS.has(k) && typeof v === 'string' ? new Date(v) : v;
  out.organizationId = organizationId;
  return out as T;
}

/** 转为 JSON 可存储值 / to a JSON-storable value */
const json = <T>(v: T) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/**
 * 删除前生成快照并放入回收站（在删除事务内、解除共享跟进之前调用）。
 * Snapshot the record into the recycle bin (call inside the delete transaction, before detaching shared activities).
 */
export async function recycle(tx: Prisma.TransactionClient, ctx: AuthContext, entity: RecycleEntity, id: string, displayName: string): Promise<void> {
  const org = ctx.organizationId;
  const field = FIELD[entity];
  const others = (['accountId', 'leadId', 'dealId'] as const).filter((f) => f !== field);
  const record =
    entity === 'lead'
      ? await tx.lead.findFirstOrThrow({ where: { id, organizationId: org } })
      : entity === 'account'
        ? await tx.account.findFirstOrThrow({ where: { id, organizationId: org } })
        : await tx.deal.findFirstOrThrow({ where: { id, organizationId: org } });
  const [notes, shared, owned, tags, attachments] = await Promise.all([
    tx.note.findMany({ where: { organizationId: org, [field]: id } }),
    tx.activity.findMany({ where: { organizationId: org, [field]: id, OR: others.map((f) => ({ [f]: { not: null } })) }, select: { id: true } }),
    tx.activity.findMany({ where: { organizationId: org, [field]: id, AND: others.map((f) => ({ [f]: null })) } }),
    entity === 'lead'
      ? tx.leadTag.findMany({ where: { leadId: id }, select: { tagId: true } })
      : entity === 'account'
        ? tx.accountTag.findMany({ where: { accountId: id }, select: { tagId: true } })
        : tx.dealTag.findMany({ where: { dealId: id }, select: { tagId: true } }),
    tx.attachment.findMany({ where: { organizationId: org, [field]: id } }),
  ]);
  const payload: Payload = {
    version: 1,
    record,
    notes,
    activities: owned,
    detachedActivityIds: shared.map((a) => a.id),
    tagIds: tags.map((t) => t.tagId),
    attachments,
    conversions: [],
  };
  let reservedNumbers: string[] = [];
  if (entity === 'account') {
    payload.contacts = await tx.contact.findMany({ where: { organizationId: org, accountId: id } });
    const contactIds = payload.contacts.map((c) => c.id as string);
    const leads = await tx.lead.findMany({
      where: { organizationId: org, OR: [{ convertedAccountId: id }, { convertedContactId: { in: contactIds } }] },
      select: { id: true, convertedAccountId: true, convertedContactId: true },
    });
    for (const l of leads) {
      if (l.convertedAccountId === id) payload.conversions.push({ leadId: l.id, field: 'convertedAccountId', value: id });
      if (l.convertedContactId && contactIds.includes(l.convertedContactId)) payload.conversions.push({ leadId: l.id, field: 'convertedContactId', value: l.convertedContactId });
    }
  }
  if (entity === 'deal') {
    payload.lineItems = await tx.dealLineItem.findMany({ where: { organizationId: org, dealId: id } });
    payload.quotes = await tx.quote.findMany({ where: { organizationId: org, dealId: id }, include: { lines: true } });
    reservedNumbers = payload.quotes.map((q) => q.quoteNumber as string);
    const leads = await tx.lead.findMany({ where: { organizationId: org, convertedDealId: id }, select: { id: true } });
    payload.conversions = leads.map((l) => ({ leadId: l.id, field: 'convertedDealId' as const, value: id }));
  }
  const summary = {
    notes: notes.length,
    activities: owned.length + shared.length,
    tags: tags.length,
    attachments: attachments.length,
    contacts: payload.contacts?.length ?? 0,
    lineItems: payload.lineItems?.length ?? 0,
    quotes: payload.quotes?.length ?? 0,
  };
  const now = new Date();
  // 同一记录不会重复进入回收站（恢复时会移除条目）；以防万一先清理旧条目
  // a record cannot be in the bin twice (restore removes the entry); clear any stale entry defensively
  await tx.recycleBinItem.deleteMany({ where: { organizationId: org, entityType: entity, entityId: id } });
  await tx.recycleBinItem.create({
    data: {
      organizationId: org,
      entityType: entity,
      entityId: id,
      displayName: displayName.slice(0, 200) || id,
      summary,
      payload: json(payload),
      reservedNumbers,
      deletedById: ctx.userId,
      deletedAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * DAY_MS),
    },
  });
}

/**
 * 删除快照中附件对应的磁盘文件（在数据库事务提交之后调用）。
 * Delete the files of a snapshot's attachments (call after the database transaction commits).
 */
async function removeSnapshotFiles(organizationId: string, payloads: unknown[]): Promise<void> {
  for (const p of payloads) {
    for (const a of (p as Payload).attachments ?? []) await removeFile(organizationId, a.id as string).catch(() => undefined);
  }
}

/**
 * 清除过期条目（写审计，操作人为空表示系统）。
 * Remove expired entries (audited with a null actor, i.e. the system).
 */
async function expire(organizationId: string): Promise<void> {
  const expired = await prisma.recycleBinItem.findMany({
    where: { organizationId, expiresAt: { lte: new Date() } },
    select: { id: true, entityType: true, entityId: true, displayName: true, payload: true },
  });
  if (!expired.length) return;
  const removed = await prisma.$transaction(async (tx) => {
    const done: unknown[] = [];
    for (const e of expired) {
      const { count } = await tx.recycleBinItem.deleteMany({ where: { id: e.id } });
      if (count) {
        done.push(e.payload);
        await audit(tx, { organizationId, actorId: null, action: `${e.entityType}.expire`, entityType: e.entityType, entityId: e.entityId, changes: { name: e.displayName } });
      }
    }
    return done;
  });
  await removeSnapshotFiles(organizationId, removed);
}

/**
 * 回收站列表（需删除权限；先清除过期条目），最新删除在前。
 * List the recycle bin (delete permission; expired entries are removed first), newest first.
 */
export async function listRecycleBin(ctx: AuthContext, query: z.infer<typeof recycleListSchema>) {
  requirePermission(ctx, 'record.delete');
  await expire(ctx.organizationId);
  const items = await prisma.recycleBinItem.findMany({
    where: { organizationId: ctx.organizationId, entityType: query.entityType, displayName: query.q ? containsText(query.q) : undefined },
    select: {
      id: true,
      entityType: true,
      entityId: true,
      displayName: true,
      summary: true,
      deletedAt: true,
      expiresAt: true,
      deletedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
    take: 500,
  });
  return { items, retentionDays: RETENTION_DAYS };
}

/** 依赖缺失 / missing dependency */
const missing = (field: string, code: string) => new ApiError(409, 'CONFLICT', 'Cannot restore', { [field]: [code] });

/**
 * 恢复条目：在一个事务内按原 ID 写回记录与附属数据，并移除条目、写审计。
 * Restore an entry: write the record and its related data back with original ids in one transaction, remove the entry, audit.
 */
export async function restoreItem(ctx: AuthContext, itemId: string) {
  requirePermission(ctx, 'record.delete');
  const org = ctx.organizationId;
  return prisma.$transaction(async (tx) => {
    const item = await tx.recycleBinItem.findFirst({ where: { id: itemId, organizationId: org, expiresAt: { gt: new Date() } } });
    if (!item) throw notFound();
    // 先删除条目：并发的第二次恢复会得到 404 / remove the entry first so a concurrent second restore gets 404
    const { count } = await tx.recycleBinItem.deleteMany({ where: { id: item.id } });
    if (!count) throw notFound();
    const p = item.payload as unknown as Payload;
    const entity = item.entityType as RecycleEntity;
    const id = item.entityId;
    const field = FIELD[entity];
    const exists = {
      account: async (v: unknown) => !!v && (await tx.account.count({ where: { id: v as string, organizationId: org } })) > 0,
      contact: async (v: unknown) => !!v && (await tx.contact.count({ where: { id: v as string, organizationId: org } })) > 0,
      deal: async (v: unknown) => !!v && (await tx.deal.count({ where: { id: v as string, organizationId: org } })) > 0,
    };
    const skipped: string[] = [];

    if (entity === 'lead') {
      const rec = revive<Prisma.LeadUncheckedCreateInput>(p.record, org);
      // 线索的转化目标已不存在时置空（保留转化状态与时间）/ clear vanished conversion targets (keep status and time)
      if (rec.convertedAccountId && !(await exists.account(rec.convertedAccountId))) {
        rec.convertedAccountId = null;
        skipped.push('convertedAccount');
      }
      if (rec.convertedContactId && !(await exists.contact(rec.convertedContactId))) {
        rec.convertedContactId = null;
        skipped.push('convertedContact');
      }
      if (rec.convertedDealId && !(await exists.deal(rec.convertedDealId))) {
        rec.convertedDealId = null;
        skipped.push('convertedDeal');
      }
      await tx.lead.create({ data: rec });
    } else if (entity === 'account') {
      await tx.account.create({ data: revive<Prisma.AccountUncheckedCreateInput>(p.record, org) });
      await tx.contact.createMany({ data: (p.contacts ?? []).map((c) => revive<Prisma.ContactCreateManyInput>(c, org)) });
    } else {
      const rec = revive<Prisma.DealUncheckedCreateInput>(p.record, org);
      if (!(await exists.account(rec.accountId))) throw missing('account', 'missing');
      const productIds = [...new Set((p.lineItems ?? []).map((i) => i.productId as string))];
      if (productIds.length && (await tx.product.count({ where: { organizationId: org, id: { in: productIds } } })) !== productIds.length) {
        throw missing('products', 'missing');
      }
      await tx.deal.create({ data: rec });
      await tx.dealLineItem.createMany({ data: (p.lineItems ?? []).map((i) => revive<Prisma.DealLineItemCreateManyInput>(i, org)) });
      for (const q of p.quotes ?? []) {
        const { lines, ...quote } = q;
        await tx.quote.create({ data: revive<Prisma.QuoteUncheckedCreateInput>(quote, org) });
        await tx.quoteLineItem.createMany({ data: lines.map((l) => revive<Prisma.QuoteLineItemCreateManyInput>(l, org)) });
      }
    }

    await tx.note.createMany({ data: p.notes.map((n) => revive<Prisma.NoteCreateManyInput>(n, org)) });
    await tx.attachment.createMany({ data: (p.attachments ?? []).map((x) => revive<Prisma.AttachmentCreateManyInput>(x, org)) });
    await tx.activity.createMany({ data: p.activities.map((a) => revive<Prisma.ActivityCreateManyInput>(a, org)) });
    // 共享跟进：仍存在且该关联为空时重新关联 / re-link shared activities that still exist and are unlinked
    const relinked = p.detachedActivityIds.length
      ? (await tx.activity.updateMany({ where: { organizationId: org, id: { in: p.detachedActivityIds }, [field]: null }, data: { [field]: id } })).count
      : 0;
    if (relinked < p.detachedActivityIds.length) skipped.push('activities');
    const tagIds = (await tx.tag.findMany({ where: { organizationId: org, id: { in: p.tagIds } }, select: { id: true } })).map((t) => t.id);
    if (tagIds.length < p.tagIds.length) skipped.push('tags');
    if (entity === 'lead') await tx.leadTag.createMany({ data: tagIds.map((tagId) => ({ organizationId: org, leadId: id, tagId })) });
    if (entity === 'account') await tx.accountTag.createMany({ data: tagIds.map((tagId) => ({ organizationId: org, accountId: id, tagId })) });
    if (entity === 'deal') await tx.dealTag.createMany({ data: tagIds.map((tagId) => ({ organizationId: org, dealId: id, tagId })) });
    // 转化来源线索：线索仍存在且该字段为空时重新关联 / re-link conversion leads that still exist with the field empty
    for (const c of p.conversions) {
      const r = await tx.lead.updateMany({ where: { id: c.leadId, organizationId: org, [c.field]: null }, data: { [c.field]: c.value } });
      if (!r.count) skipped.push('conversions');
    }

    await audit(tx, {
      ...by(ctx),
      action: `${entity}.restore`,
      entityType: entity,
      entityId: id,
      changes: { name: item.displayName, summary: item.summary, skipped: [...new Set(skipped)] },
    });
    return { entityType: entity, entityId: id, skipped: [...new Set(skipped)] };
  });
}

/**
 * 彻底删除一个条目（需 recycle.purge）。
 * Permanently delete one entry (recycle.purge).
 */
export async function purgeItem(ctx: AuthContext, itemId: string): Promise<void> {
  requirePermission(ctx, 'recycle.purge');
  const payload = await prisma.$transaction(async (tx) => {
    const item = await tx.recycleBinItem.findFirst({ where: { id: itemId, organizationId: ctx.organizationId }, select: { id: true, entityType: true, entityId: true, displayName: true, payload: true } });
    if (!item) throw notFound();
    await tx.recycleBinItem.delete({ where: { id: item.id } });
    await audit(tx, { ...by(ctx), action: `${item.entityType}.purge`, entityType: item.entityType, entityId: item.entityId, changes: { name: item.displayName } });
    return item.payload;
  });
  await removeSnapshotFiles(ctx.organizationId, [payload]);
}

/**
 * 清空回收站（需 recycle.purge），逐条写审计。
 * Empty the recycle bin (recycle.purge), auditing each entry.
 */
export async function emptyRecycleBin(ctx: AuthContext): Promise<{ purged: number }> {
  requirePermission(ctx, 'recycle.purge');
  const items = await prisma.$transaction(async (tx) => {
    const list = await tx.recycleBinItem.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, entityType: true, entityId: true, displayName: true, payload: true } });
    await tx.recycleBinItem.deleteMany({ where: { id: { in: list.map((i) => i.id) } } });
    for (const i of list) {
      await audit(tx, { ...by(ctx), action: `${i.entityType}.purge`, entityType: i.entityType, entityId: i.entityId, changes: { name: i.displayName, via: 'recycle.empty' } });
    }
    return list;
  });
  await removeSnapshotFiles(ctx.organizationId, items.map((i) => i.payload));
  return { purged: items.length };
}
