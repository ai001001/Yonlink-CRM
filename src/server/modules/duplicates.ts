/**
 * 重复记录检测与合并（参考 Zoho Deduplication）：线索与客户。
 *
 * 检测规则（满足任一即归为同组，组内显示匹配依据）/ Detection rules (any match puts records into one group):
 * - 线索：邮箱相同（不区分大小写）；电话或手机相同（只比较数字，取后 11 位，至少 7 位）；姓名 + 公司相同（忽略大小写与空白）。
 * - 客户：名称相同（忽略大小写、空白与标点）；电话相同；网站域名相同（忽略协议、www、端口与路径）。
 * 检测遵循可见范围（销售代表只在自己负责的记录中查找），每次最多扫描 20000 条。
 *
 * 合并 / Merge:
 * - 需删除权限（管理员、经理）且能编辑主记录；选择主记录并逐字段选择保留值（改负责人需指派权限）。
 * - 相关数据转到主记录：线索的备注、跟进、附件、标签；客户的联系人、商机、备注、跟进、附件、标签与转化来源线索。
 * - 被合并的记录放入回收站（相关数据已转移，恢复只找回记录本身）；已转化的线索不能合并；一次最多 10 条。
 * - 在一个事务内完成并写审计（merge：合并了哪些记录、字段变化、转移数量）。
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { assertCanUpdate, assertOwnerAssignable, requirePermission, visible } from '../permissions';
import { recycle } from './recycle-bin';
import { MAX_TAGS_PER_RECORD } from './tags';

/** 支持的对象 / supported entities */
export const DEDUPE_ENTITIES = ['leads', 'accounts'] as const;
export type DedupeEntity = (typeof DEDUPE_ENTITIES)[number];
/** 单次扫描上限 / scan limit */
export const SCAN_LIMIT = 20_000;
/** 单次合并的重复记录上限 / maximum duplicates merged at once */
export const MERGE_MAX = 10;

/** 可在合并时选择的字段 / fields selectable when merging */
export const MERGE_FIELDS: Record<DedupeEntity, readonly string[]> = {
  leads: ['name', 'company', 'title', 'phone', 'mobile', 'email', 'source', 'status', 'description', 'ownerId'],
  accounts: ['name', 'industry', 'phone', 'website', 'address', 'description', 'ownerId'],
};

/** 查重查询 / detection query */
export const duplicateQuerySchema = z.strictObject({ entity: z.enum(DEDUPE_ENTITIES) });

/** 合并请求 / merge request */
export const mergeSchema = z
  .strictObject({
    entity: z.enum(DEDUPE_ENTITIES),
    masterId: z.uuid(),
    duplicateIds: z.array(z.uuid()).min(1).max(MERGE_MAX),
    /** 字段 → 取值来源记录 ID（缺省取主记录）/ field → id of the record whose value is kept (default: master) */
    fields: z.record(z.string(), z.uuid()).default({}),
  })
  .superRefine((v, c) => {
    if (new Set(v.duplicateIds).size !== v.duplicateIds.length) c.addIssue({ code: 'custom', path: ['duplicateIds'], message: 'Duplicate ids' });
    if (v.duplicateIds.includes(v.masterId)) c.addIssue({ code: 'custom', path: ['duplicateIds'], message: 'Master cannot be a duplicate' });
    const allowed = MERGE_FIELDS[v.entity];
    const ids = [v.masterId, ...v.duplicateIds];
    for (const [field, source] of Object.entries(v.fields)) {
      if (!allowed.includes(field)) c.addIssue({ code: 'custom', path: ['fields', field], message: 'Field cannot be merged' });
      else if (!ids.includes(source)) c.addIssue({ code: 'custom', path: ['fields', field], message: 'Source is not part of the merge' });
    }
  });

/** 邮箱键 / email key */
export const emailKey = (v: string | null) => (v ? v.trim().toLowerCase() || null : null);
/**
 * 电话键：只保留数字，取后 11 位（兼容 +86 等国际区号），不足 7 位视为无效。
 * Phone key: digits only, last 11 digits (tolerates +86 and other prefixes); fewer than 7 digits is ignored.
 */
export function phoneKey(v: string | null): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-11) : null;
}
/** 名称键：忽略大小写、空白与标点 / name key ignoring case, whitespace and punctuation */
export const nameKey = (v: string | null) => (v ? v.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '') || null : null);
/**
 * 网站域名键：去掉协议、www、端口与路径。
 * Website domain key: protocol, www, port and path removed.
 */
export function domainKey(v: string | null): string | null {
  const host = (v ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
  return host.includes('.') ? host : null;
}

/**
 * 按规则把记录分组（并查集），只返回 2 条及以上的组。
 * Group records by rules (union-find); only groups of two or more are returned.
 */
export function groupDuplicates<T extends { id: string }>(records: T[], rules: Record<string, (r: T) => (string | null)[] | string | null>) {
  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const reasons = new Map<string, Set<string>>();
  for (const [rule, keyOf] of Object.entries(rules)) {
    const seen = new Map<string, string>();
    for (const r of records) {
      // 一条记录可有多个键（如电话与手机）/ a record may have several keys (e.g. phone and mobile)
      const keys = [...new Set([keyOf(r)].flat().filter((k): k is string => !!k))];
      for (const k of keys) {
        const first = seen.get(k);
        if (!first) {
          seen.set(k, r.id);
          continue;
        }
        if (first === r.id) continue;
        const [a, b] = [find(first), find(r.id)];
        if (a !== b) parent.set(b, a);
        for (const id of [first, r.id]) reasons.set(id, (reasons.get(id) ?? new Set()).add(rule));
      }
    }
  }
  const groups = new Map<string, T[]>();
  for (const r of records) {
    const root = find(r.id);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ reasons: [...new Set(g.flatMap((r) => [...(reasons.get(r.id) ?? [])]))].sort(), records: g }));
}

/**
 * 查找重复记录（遵循可见范围），组内按创建时间排序（最早的建议作为主记录）。
 * Find duplicates within the visible records; groups are sorted by creation time (the oldest is the suggested master).
 */
export async function findDuplicates(ctx: AuthContext, query: z.infer<typeof duplicateQuerySchema>) {
  const owner = { owner: { select: { id: true, name: true } } } as const;
  if (query.entity === 'leads') {
    const rows = await prisma.lead.findMany({
      where: { ...visible(ctx) },
      select: { id: true, name: true, company: true, email: true, phone: true, mobile: true, status: true, ownerId: true, createdAt: true, ...owner, _count: { select: { notes: true, activities: true, attachments: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SCAN_LIMIT,
    });
    const groups = groupDuplicates(rows, {
      email: (r) => emailKey(r.email),
      phone: (r) => [phoneKey(r.mobile), phoneKey(r.phone)],
      nameCompany: (r) => (r.company ? `${nameKey(r.name)}|${nameKey(r.company)}` : null),
    });
    return { entity: query.entity, scanned: rows.length, truncated: rows.length === SCAN_LIMIT, groups };
  }
  const rows = await prisma.account.findMany({
    where: { ...visible(ctx) },
    select: { id: true, name: true, industry: true, phone: true, website: true, ownerId: true, createdAt: true, ...owner, _count: { select: { contacts: true, deals: true, notes: true, activities: true, attachments: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: SCAN_LIMIT,
  });
  const groups = groupDuplicates(rows, {
    name: (r) => nameKey(r.name),
    phone: (r) => phoneKey(r.phone),
    website: (r) => domainKey(r.website),
  });
  return { entity: query.entity, scanned: rows.length, truncated: rows.length === SCAN_LIMIT, groups };
}

/** 标签合并（超过上限 400）/ merge tags (400 above the limit) */
function unionTags(master: string[], others: string[]): string[] {
  const all = [...new Set([...master, ...others])];
  if (all.length > MAX_TAGS_PER_RECORD) throw new ApiError(400, 'VALIDATION_ERROR', 'Too many tags after merge', { tags: ['limit'] });
  return all.filter((t) => !master.includes(t));
}

/**
 * 合并重复记录。
 * Merge duplicate records into the master.
 */
export async function mergeDuplicates(ctx: AuthContext, input: z.infer<typeof mergeSchema>) {
  requirePermission(ctx, 'record.delete');
  const ids = [input.masterId, ...input.duplicateIds];
  const org = ctx.organizationId;
  return prisma.$transaction(async (tx) => {
    const records = (
      input.entity === 'leads'
        ? await tx.lead.findMany({ where: { id: { in: ids }, ...visible(ctx) }, include: { tags: { select: { tagId: true } } } })
        : await tx.account.findMany({ where: { id: { in: ids }, ...visible(ctx) }, include: { tags: { select: { tagId: true } } } })
    ) as (Record<string, unknown> & { id: string; ownerId: string | null; name: string; tags: { tagId: string }[] })[];
    if (records.length !== ids.length) throw new ApiError(404, 'NOT_FOUND', 'Record not found');
    const byId = new Map(records.map((r) => [r.id, r]));
    const master = byId.get(input.masterId)!;
    assertCanUpdate(ctx, master);
    if (input.entity === 'leads' && records.some((r) => r.status === 'CONVERTED')) {
      throw new ApiError(409, 'CONFLICT', 'Converted leads cannot be merged', { ids: ['converted'] });
    }
    // 主记录的新字段值 / new field values for the master
    const data: Record<string, unknown> = {};
    for (const [field, source] of Object.entries(input.fields)) {
      const v = byId.get(source)![field];
      if (v !== master[field]) data[field] = v;
    }
    if ('ownerId' in data) assertOwnerAssignable(ctx, (data.ownerId as string | null) ?? null);

    const dupIds = input.duplicateIds;
    const moved: Record<string, number> = {};
    const tagIds = unionTags(
      master.tags.map((t) => t.tagId),
      dupIds.flatMap((id) => byId.get(id)!.tags.map((t) => t.tagId)),
    );
    if (input.entity === 'leads') {
      moved.notes = (await tx.note.updateMany({ where: { organizationId: org, leadId: { in: dupIds } }, data: { leadId: master.id } })).count;
      moved.activities = (await tx.activity.updateMany({ where: { organizationId: org, leadId: { in: dupIds } }, data: { leadId: master.id } })).count;
      moved.attachments = (await tx.attachment.updateMany({ where: { organizationId: org, leadId: { in: dupIds } }, data: { leadId: master.id } })).count;
      await tx.leadTag.createMany({ data: tagIds.map((tagId) => ({ organizationId: org, leadId: master.id, tagId })), skipDuplicates: true });
      if (Object.keys(data).length) await tx.lead.update({ where: { id: master.id }, data: data as Prisma.LeadUncheckedUpdateInput });
    } else {
      // 联系人：主客户已有主要联系人时，转入的联系人不再是主要联系人 / moved contacts lose primary when the master has one
      const masterHasPrimary = (await tx.contact.count({ where: { organizationId: org, accountId: master.id, isPrimary: true } })) > 0;
      if (masterHasPrimary) await tx.contact.updateMany({ where: { organizationId: org, accountId: { in: dupIds } }, data: { isPrimary: false } });
      else {
        const primaries = await tx.contact.findMany({ where: { organizationId: org, accountId: { in: dupIds }, isPrimary: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        if (primaries.length > 1) await tx.contact.updateMany({ where: { id: { in: primaries.slice(1).map((p) => p.id) } }, data: { isPrimary: false } });
      }
      moved.contacts = (await tx.contact.updateMany({ where: { organizationId: org, accountId: { in: dupIds } }, data: { accountId: master.id } })).count;
      moved.deals = (await tx.deal.updateMany({ where: { organizationId: org, accountId: { in: dupIds } }, data: { accountId: master.id } })).count;
      moved.notes = (await tx.note.updateMany({ where: { organizationId: org, accountId: { in: dupIds } }, data: { accountId: master.id } })).count;
      moved.activities = (await tx.activity.updateMany({ where: { organizationId: org, accountId: { in: dupIds } }, data: { accountId: master.id } })).count;
      moved.attachments = (await tx.attachment.updateMany({ where: { organizationId: org, accountId: { in: dupIds } }, data: { accountId: master.id } })).count;
      moved.conversions = (await tx.lead.updateMany({ where: { organizationId: org, convertedAccountId: { in: dupIds } }, data: { convertedAccountId: master.id } })).count;
      await tx.accountTag.createMany({ data: tagIds.map((tagId) => ({ organizationId: org, accountId: master.id, tagId })), skipDuplicates: true });
      if (Object.keys(data).length) await tx.account.update({ where: { id: master.id }, data: data as Prisma.AccountUncheckedUpdateInput });
    }
    moved.tags = tagIds.length;

    // 被合并的记录放入回收站后删除 / merged records go to the recycle bin, then are deleted
    const single = input.entity === 'leads' ? 'lead' : 'account';
    for (const id of dupIds) {
      const r = byId.get(id)!;
      await recycle(tx, ctx, single, id, r.company ? `${r.name}（${String(r.company)}）` : r.name);
      if (input.entity === 'leads') await tx.lead.delete({ where: { id } });
      else await tx.account.delete({ where: { id } });
      await audit(tx, { ...by(ctx), action: `${single}.delete`, entityType: single, entityId: id, changes: { before: snapshot(single, r), recycled: true, mergedInto: master.id } });
    }
    const after = { ...master, ...data };
    await audit(tx, {
      ...by(ctx),
      action: `${single}.merge`,
      entityType: single,
      entityId: master.id,
      changes: { merged: dupIds.map((id) => ({ id, name: byId.get(id)!.name })), fields: diff(single, master, after), moved },
    });
    return { entity: input.entity, masterId: master.id, merged: dupIds.length, moved };
  });
}
