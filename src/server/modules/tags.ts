/**
 * 标签应用服务（参考 Zoho Tags）：线索、客户、商机可打多个彩色标签。
 * - 标签名在组织内唯一（不区分大小写，name_key = 小写去空格），颜色来自预设色板。
 * - 能编辑记录的用户可新建标签；改名、改色、删除需 tag.manage（管理员、经理）；删除标签同时移除其所有关联，
 *   并从引用它的保存视图中去掉标签筛选。
 * - 给记录打标签需能编辑该记录；每条记录最多 20 个标签，每个组织最多 200 个标签。
 * Tags service (cf. Zoho Tags) for leads, accounts and deals: case-insensitive unique names per organization,
 * preset colours; users who can edit records may create tags; renaming, recolouring and deleting require
 * tag.manage; tagging a record requires edit rights on it; ≤ 20 tags per record, ≤ 200 per organization.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, requirePermission, visible } from '../permissions';

/** 预设颜色（与界面色板、数据库 CHECK 一致）/ preset colours (matches the UI palette and the DB CHECK) */
export const TAG_COLORS = ['blue', 'green', 'gold', 'red', 'purple', 'cyan', 'orange', 'magenta', 'geekblue', 'volcano'] as const;
/** 每条记录最多标签数 / maximum tags per record */
export const MAX_TAGS_PER_RECORD = 20;
/** 每个组织最多标签数 / maximum tags per organization */
export const MAX_TAGS_PER_ORG = 200;

/** 可打标签的对象 / taggable entities */
export type TaggableEntity = 'lead' | 'account' | 'deal';

const name = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[^,<>]+$/, 'Invalid tag name');

/** 新建标签 / Create tag */
export const tagCreateSchema = z.strictObject({ name, color: z.enum(TAG_COLORS).default('blue') });
/** 修改标签 / Update tag */
export const tagUpdateSchema = z.strictObject({ name, color: z.enum(TAG_COLORS) }).partial();
/** 设置记录的标签（完整集合）/ Set a record's tags (full set) */
export const recordTagsSchema = z.strictObject({
  tagIds: z
    .array(z.uuid())
    .max(MAX_TAGS_PER_RECORD)
    .transform((v) => [...new Set(v)]),
});

/** 名称键 / name key */
const keyOf = (v: string) => v.trim().toLowerCase();

/** 记录返回时附带的标签 / tags included with records */
export const tagsInclude = { select: { tag: { select: { id: true, name: true, color: true } } }, orderBy: { tag: { nameKey: 'asc' } } } as const;

/**
 * 按标签筛选的条件（列表与导出共用）。
 * Filter condition by tag (shared by lists and exports).
 */
export const tagFilter = (tagId: string | undefined) => (tagId ? { tags: { some: { tagId } } } : {});

/**
 * 组织内全部标签及使用次数（次数遵循可见范围：销售代表只统计自己负责的记录）。
 * All tags with usage counts (counts follow visibility: sales reps count only their own records).
 */
export async function listTags(ctx: AuthContext) {
  const scope = visible(ctx);
  const owner = scope.ownerId ? { ownerId: scope.ownerId } : {};
  return prisma.tag.findMany({
    where: { organizationId: ctx.organizationId },
    select: {
      id: true,
      name: true,
      color: true,
      _count: { select: { leads: { where: { lead: owner } }, accounts: { where: { account: owner } }, deals: { where: { deal: owner } } } },
    },
    orderBy: { nameKey: 'asc' },
  });
}

/** 名称重复 / duplicate name */
const nameTaken = () => new ApiError(409, 'CONFLICT', 'Tag name already exists', { name: ['taken'] });

/**
 * 新建标签（能编辑记录的用户均可；名称重复 409；超过上限 400）。
 * Create a tag (anyone who can edit records; duplicate → 409; over the limit → 400).
 */
export async function createTag(ctx: AuthContext, input: z.infer<typeof tagCreateSchema>) {
  requirePermission(ctx, 'record.update.own');
  if ((await prisma.tag.count({ where: { organizationId: ctx.organizationId } })) >= MAX_TAGS_PER_ORG) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Too many tags', { name: ['limit'] });
  }
  if (await prisma.tag.count({ where: { organizationId: ctx.organizationId, nameKey: keyOf(input.name) } })) throw nameTaken();
  return prisma.$transaction(async (tx) => {
    const tag = await tx.tag.create({ data: { organizationId: ctx.organizationId, name: input.name, nameKey: keyOf(input.name), color: input.color } });
    await audit(tx, { ...by(ctx), action: 'tag.create', entityType: 'tag', entityId: tag.id, changes: { after: snapshot('tag', tag) } });
    return { id: tag.id, name: tag.name, color: tag.color };
  });
}

/**
 * 读取本组织标签。
 * Load a tag of this organization.
 */
async function requireTag(ctx: AuthContext, id: string) {
  const tag = await prisma.tag.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!tag) throw notFound();
  return tag;
}

/**
 * 改名、改色（需 tag.manage）。
 * Rename or recolour (tag.manage).
 */
export async function updateTag(ctx: AuthContext, id: string, input: z.infer<typeof tagUpdateSchema>) {
  requirePermission(ctx, 'tag.manage');
  const current = await requireTag(ctx, id);
  const data: Prisma.TagUpdateInput = { ...input };
  if (input.name !== undefined) {
    data.nameKey = keyOf(input.name);
    if (data.nameKey !== current.nameKey && (await prisma.tag.count({ where: { organizationId: ctx.organizationId, nameKey: data.nameKey } }))) throw nameTaken();
  }
  return prisma.$transaction(async (tx) => {
    const tag = await tx.tag.update({ where: { id }, data });
    const fields = diff('tag', current, tag);
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'tag.update', entityType: 'tag', entityId: id, changes: { fields } });
    return { id: tag.id, name: tag.name, color: tag.color };
  });
}

/**
 * 删除标签及其所有关联（需 tag.manage），审计记录移除的关联数。
 * Delete a tag and all assignments (tag.manage); the audit records how many were removed.
 */
export async function deleteTag(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'tag.manage');
  const tag = await requireTag(ctx, id);
  await prisma.$transaction(async (tx) => {
    const [leads, accounts, deals] = await Promise.all([
      tx.leadTag.count({ where: { tagId: id } }),
      tx.accountTag.count({ where: { tagId: id } }),
      tx.dealTag.count({ where: { tagId: id } }),
    ]);
    await tx.tag.delete({ where: { id } });
    // 引用该标签的视图（私有与共享）去掉标签筛选，避免视图筛出空列表 / drop the tag filter from views that use it
    const views = await tx.$executeRaw`
      UPDATE saved_views SET filters = filters - 'tagId', updated_at = now()
      WHERE organization_id = ${ctx.organizationId}::uuid AND filters->>'tagId' = ${id}`;
    await audit(tx, {
      ...by(ctx),
      action: 'tag.delete',
      entityType: 'tag',
      entityId: id,
      changes: { before: snapshot('tag', tag), removed: { leads, accounts, deals }, views },
    });
  });
}

/**
 * 读取可见记录（用于权限判断）。
 * Load a visible record (for the permission check).
 */
async function requireRecord(ctx: AuthContext, entity: TaggableEntity, id: string): Promise<{ ownerId: string | null }> {
  const where = { id, ...visible(ctx) };
  const select = { ownerId: true } as const;
  const record =
    entity === 'lead'
      ? await prisma.lead.findFirst({ where, select })
      : entity === 'account'
        ? await prisma.account.findFirst({ where, select })
        : await prisma.deal.findFirst({ where, select });
  if (!record) throw notFound();
  return record;
}

/**
 * 当前标签 ID 列表。
 * Current tag ids of a record.
 */
async function currentTagIds(tx: Prisma.TransactionClient, entity: TaggableEntity, id: string): Promise<string[]> {
  const rows =
    entity === 'lead'
      ? await tx.leadTag.findMany({ where: { leadId: id }, select: { tagId: true } })
      : entity === 'account'
        ? await tx.accountTag.findMany({ where: { accountId: id }, select: { tagId: true } })
        : await tx.dealTag.findMany({ where: { dealId: id }, select: { tagId: true } });
  return rows.map((r) => r.tagId);
}

/**
 * 修改记录的标签：next 根据当前集合计算目标集合；只写入差异并审计新增/移除的标签名。
 * Change a record's tags: `next` maps the current set to the target; only differences are written and the
 * added/removed tag names are audited.
 */
export async function changeRecordTags(ctx: AuthContext, entity: TaggableEntity, id: string, next: (current: string[]) => string[]) {
  const record = await requireRecord(ctx, entity, id);
  assertCanUpdate(ctx, record);
  return prisma.$transaction(async (tx) => {
    const current = await currentTagIds(tx, entity, id);
    const target = [...new Set(next(current))];
    if (target.length > MAX_TAGS_PER_RECORD) throw new ApiError(400, 'VALIDATION_ERROR', 'Too many tags on the record', { tagIds: ['limit'] });
    const tags = await tx.tag.findMany({ where: { organizationId: ctx.organizationId, id: { in: target } }, select: { id: true, name: true } });
    if (tags.length !== target.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid tag', { tagIds: ['not_found'] });
    const added = target.filter((t) => !current.includes(t));
    const removed = current.filter((t) => !target.includes(t));
    if (added.length || removed.length) {
      const org = ctx.organizationId;
      if (entity === 'lead') {
        await tx.leadTag.deleteMany({ where: { leadId: id, tagId: { in: removed } } });
        await tx.leadTag.createMany({ data: added.map((tagId) => ({ organizationId: org, leadId: id, tagId })), skipDuplicates: true });
      } else if (entity === 'account') {
        await tx.accountTag.deleteMany({ where: { accountId: id, tagId: { in: removed } } });
        await tx.accountTag.createMany({ data: added.map((tagId) => ({ organizationId: org, accountId: id, tagId })), skipDuplicates: true });
      } else {
        await tx.dealTag.deleteMany({ where: { dealId: id, tagId: { in: removed } } });
        await tx.dealTag.createMany({ data: added.map((tagId) => ({ organizationId: org, dealId: id, tagId })), skipDuplicates: true });
      }
      const names = new Map((await tx.tag.findMany({ where: { id: { in: [...added, ...removed] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
      await audit(tx, {
        ...by(ctx),
        action: `${entity}.tags`,
        entityType: entity,
        entityId: id,
        changes: { added: added.map((t) => names.get(t)), removed: removed.map((t) => names.get(t)) },
      });
    }
    return tx.tag.findMany({ where: { id: { in: target } }, select: { id: true, name: true, color: true }, orderBy: { nameKey: 'asc' } });
  });
}

/**
 * 设置记录的完整标签集合。
 * Set a record's full tag set.
 */
export function setRecordTags(ctx: AuthContext, entity: TaggableEntity, id: string, input: z.infer<typeof recordTagsSchema>) {
  return changeRecordTags(ctx, entity, id, () => input.tagIds);
}
