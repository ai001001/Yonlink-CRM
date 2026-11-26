/**
 * 客户与联系人应用服务。联系人作为客户的子数据管理。
 * Accounts & contacts application service. Contacts are managed as account children.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { assertCanDelete, assertCanUpdate, assertOwnerAssignable, can, requirePermission, visible } from '../permissions';
import { ApiError, notFound } from '../errors';
import { assertOption, lockCustomOption, picklistCode } from './picklists';
import { customDiff, customInput, resolveCustom } from './custom-fields';
import { INDUSTRIES } from './dictionaries';
import { runWorkflows } from './workflows';
import { readableAccounts, readableDeals, resolveTerritory, territoryIdsFor, territoryReadScope } from './territory-rules';
import { territoryFilter, territoryInput } from './territory-input';
import { detachSharedActivities } from './activities';
import { notifyAssigned } from './notifications';
import { recycle } from './recycle-bin';
import { gradeRange, scoreListFields, scoreOrder } from './scoring-grades';
import { tagFilter, tagsInclude } from './tags';
import { containsText, listQuery, optionalEmail, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';

/** 行业字典（定义在 dictionaries，此处转出以兼容旧引用）/ industry dictionary (re-exported from dictionaries) */
export { INDUSTRIES };

const accountFields = {
  name: requiredText(200),
  // 行业可为自定义选项，写入时按组织配置检查 / industries may be custom options, checked on write
  industry: picklistCode.nullish().transform((v) => v ?? null),
  phone: optionalText(50),
  website: optionalText(254),
  address: optionalText(500),
  description: optionalText(5000),
  ownerId: optionalUuid.optional(),
  /** 自定义字段的值 / custom field values */
  custom: customInput,
  /** 区域：ID 或 null 为手工指定，AUTO 为按规则（需 territory.manage）/ territory: an id or null sets it by hand, AUTO uses rules (territory.manage) */
  territoryId: territoryInput,
};

/** 新建客户 / Create account */
export const accountCreateSchema = z.strictObject(accountFields);
/** 更新客户 / Update account */
export const accountUpdateSchema = accountCreateSchema.partial();
/** 客户列表查询 / Account list query */
export const accountListSchema = listQuery.extend({
  industry: picklistCode.optional(),
  ownerId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  /** 区域（含下级）、NONE 或 MINE / territory (with descendants), NONE or MINE */
  territoryId: territoryFilter,
  ...scoreListFields,
});

const contactFields = {
  name: requiredText(100),
  title: optionalText(100),
  phone: optionalText(50),
  email: optionalEmail,
  isPrimary: z.boolean().default(false),
  /** 自定义字段的值 / custom field values */
  custom: customInput,
};
/** 新建联系人 / Create contact */
export const contactCreateSchema = z.strictObject(contactFields);
/** 更新联系人 / Update contact */
export const contactUpdateSchema = z.strictObject({ ...contactFields, isPrimary: z.boolean() }).partial();
/** 联系人列表查询（跨客户）；负责人指所属客户的负责人 / Contact list query across accounts; owner = the account owner */
export const contactListSchema = listQuery.extend({
  accountId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  isPrimary: z.enum(['true', 'false']).optional(),
  ...scoreListFields,
});

/** 联系人返回时附带的所属客户 / account included with contacts */
const contactInclude = { account: { select: { id: true, name: true, ownerId: true, owner: { select: { id: true, name: true } } } } } satisfies Prisma.ContactInclude;

/**
 * 客户返回内容；商机数与商机列表遵循相同可见范围（销售代表只统计自己负责的商机）。
 * Account include; the deal count follows the same visibility as the deals list (sales reps count only their own).
 */
function listInclude(ctx: AuthContext, scope: string[]) {
  // 商机数按可读范围计数（含区域只读范围）/ deal counts follow the readable scope (territory included)
  const dealScope: Prisma.DealWhereInput = can(ctx, 'record.read.all') ? {} : readableDeals(ctx, scope);
  return {
    owner: { select: { id: true, name: true } },
    territory: { select: { id: true, name: true } },
    tags: tagsInclude,
    _count: { select: { contacts: true, deals: { where: dealScope } } },
  } satisfies Prisma.AccountInclude;
}

const contactOrder: Prisma.ContactOrderByWithRelationInput[] = [{ isPrimary: 'desc' }, { createdAt: 'asc' }];

/**
 * 列表与导出共用的查询条件（可见范围 + 筛选 + 搜索）。
 * Query conditions shared by the list and the export (visibility + filters + search).
 */
export function accountWhere(
  ctx: AuthContext,
  query: Omit<z.infer<typeof accountListSchema>, 'page' | 'pageSize'>,
  score?: Prisma.IntFilter,
  territories?: string[] | null,
  scope: string[] = [],
): Prisma.AccountWhereInput {
  const territory = territories === undefined ? {} : { territoryId: territories === null ? null : { in: territories } };
  const where: Prisma.AccountWhereInput = { AND: [readableAccounts(ctx, scope), { industry: query.industry, ownerId: query.ownerId, score, ...territory }, tagFilter(query.tagId)] };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { phone: c }, { website: c }, { address: c }, { contacts: { some: { name: c } } }];
  }
  return where;
}

/**
 * 分页搜索客户（名称、电话、网站、地址、联系人姓名）。
 * Search accounts with pagination (name, phone, website, address, contact name).
 */
export async function listAccounts(ctx: AuthContext, query: z.infer<typeof accountListSchema>): Promise<Page<unknown>> {
  const scope = await territoryReadScope(ctx);
  const where = accountWhere(ctx, query, await gradeRange(ctx.organizationId, 'ACCOUNT', query.grade), await territoryIdsFor(ctx, query.territoryId), scope);
  const [items, total] = await prisma.$transaction([
    prisma.account.findMany({
      where,
      include: listInclude(ctx, scope),
      orderBy: scoreOrder<Prisma.AccountOrderByWithRelationInput>(query.sort, [{ createdAt: 'desc' }, { id: 'asc' }]),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.account.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 客户详情（含联系人）；跨组织返回 404。
 * Account detail including contacts; cross-organization access yields 404.
 */
export async function getAccount(ctx: AuthContext, id: string) {
  const scope = await territoryReadScope(ctx);
  const account = await prisma.account.findFirst({
    where: { AND: [{ id }, readableAccounts(ctx, scope)] },
    include: { ...listInclude(ctx, scope), contacts: { orderBy: contactOrder }, priceBook: { select: { id: true, name: true, isActive: true } } },
  });
  if (!account) throw notFound();
  return account;
}

/**
 * 新建客户。
 * Create an account.
 */
export async function createAccount(ctx: AuthContext, input: z.infer<typeof accountCreateSchema>) {
  const { ownerId, custom, territoryId, ...data } = input;
  requirePermission(ctx, 'record.create');
  await assertOption(ctx.organizationId, 'INDUSTRY', data.industry, null, 'industry');
  assertOwnerAssignable(ctx, ownerId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  const cf = await resolveCustom(ctx.organizationId, 'ACCOUNT', custom, null);
  const territory = await resolveTerritory(ctx, territoryId, { ...data, ownerId: owner }, null);
  const created = await prisma.$transaction(async (tx) => {
    // 自定义选项：与删除选项互斥并在事务内复核 / custom options: exclusive with removal, re-checked in the transaction
    await lockCustomOption(tx, ctx.organizationId, 'INDUSTRY', data.industry, 'industry');
    const account = await tx.account.create({ data: { ...data, ...territory, custom: cf.values as Prisma.InputJsonValue, organizationId: ctx.organizationId, ownerId: owner } });
    const customChanges = customDiff(cf.defs, null, cf.values);
    await audit(tx, { ...by(ctx), action: 'account.create', entityType: 'account', entityId: account.id, changes: { after: snapshot('account', account), ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    await notifyAssigned(tx, ctx, { entity: 'account', id: account.id }, account.name, account.ownerId, null);
    await runWorkflows(tx, { entity: 'ACCOUNT', before: null, after: account, actorId: ctx.userId, meta: ctx.meta });
    return account;
  });
  return getAccount(ctx, created.id);
}

/**
 * 更新客户。
 * Update an account.
 */
export async function updateAccount(ctx: AuthContext, id: string, input: z.infer<typeof accountUpdateSchema>) {
  const current = await getAccount(ctx, id);
  assertCanUpdate(ctx, current);
  const { ownerId, custom, territoryId, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  await assertOption(ctx.organizationId, 'INDUSTRY', data.industry, current.industry, 'industry');
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  const cf = custom === undefined ? null : await resolveCustom(ctx.organizationId, 'ACCOUNT', custom, current.custom);
  const territory = await resolveTerritory(ctx, territoryId, { ...current, ...data, ownerId: owner }, current);
  await prisma.$transaction(async (tx) => {
    // 自定义选项：与删除选项互斥并在事务内复核 / custom options: exclusive with removal, re-checked in the transaction
    if (data.industry !== current.industry) await lockCustomOption(tx, ctx.organizationId, 'INDUSTRY', data.industry, 'industry');
    const updated = await tx.account.update({ where: { id: current.id }, data: { ...data, ...territory, ownerId: owner, ...(cf ? { custom: cf.values as Prisma.InputJsonValue } : {}) } });
    await notifyAssigned(tx, ctx, { entity: 'account', id }, updated.name, updated.ownerId, current.ownerId);
    const fields = diff('account', current, updated);
    const customChanges = cf ? customDiff(cf.defs, current.custom, cf.values) : {};
    if (Object.keys(fields).length || Object.keys(customChanges).length) {
      await audit(tx, { ...by(ctx), action: 'account.update', entityType: 'account', entityId: id, changes: { fields, ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    }
    await runWorkflows(tx, { entity: 'ACCOUNT', before: current, after: updated, actorId: ctx.userId, meta: ctx.meta });
  });
  return getAccount(ctx, id);
}

/**
 * 删除客户：联系人与仅关联该客户的跟进级联删除，共享跟进解除关联后保留；存在商机时拒绝（409）。
 * Delete an account: contacts and account-only activities cascade, shared ones are kept unlinked; 409 while deals exist.
 */
export async function deleteAccount(ctx: AuthContext, id: string): Promise<void> {
  assertCanDelete(ctx);
  const account = await getAccount(ctx, id);
  // 删除判断必须用全部商机数，不能用按可见范围过滤后的计数 / use the true total, not the visibility-filtered count
  const dealTotal = await prisma.deal.count({ where: { organizationId: ctx.organizationId, accountId: account.id } });
  if (dealTotal > 0) {
    throw new ApiError(409, 'CONFLICT', 'Account has deals', { deals: [String(dealTotal)] });
  }
  // 有服务工单的客户同样不能删除（工单不进回收站）/ accounts with service tickets cannot be deleted either (tickets are not recycled)
  const ticketTotal = await prisma.ticket.count({ where: { organizationId: ctx.organizationId, accountId: account.id } });
  if (ticketTotal > 0) {
    throw new ApiError(409, 'CONFLICT', 'Account has tickets', { tickets: [String(ticketTotal)] });
  }
  // 若并发新建了商机，数据库 RESTRICT 外键仍会拒绝（P2003 → 409）
  // a concurrently created deal is still blocked by the RESTRICT FK (P2003 → 409)
  await prisma.$transaction(async (tx) => {
    // 先放入回收站（快照，含联系人），再删除 / snapshot (with contacts) into the recycle bin, then delete
    await recycle(tx, ctx, 'account', account.id, account.name);
    await detachSharedActivities(tx, ctx.organizationId, 'accountId', account.id);
    await tx.account.delete({ where: { id: account.id } });
    await audit(tx, {
      ...by(ctx),
      action: 'account.delete',
      entityType: 'account',
      entityId: account.id,
      // 联系人随客户级联删除，记录数量 / contacts cascade with the account; record how many
      changes: { before: snapshot('account', account), cascadedContacts: account._count.contacts, recycled: true },
    });
  });
}

/**
 * 读取当前用户可见的客户，不可见时 404。
 * Load an account visible to the user or throw 404.
 */
async function requireAccount(ctx: AuthContext, accountId: string): Promise<{ id: string; ownerId: string | null }> {
  const row = await prisma.account.findFirst({ where: { AND: [{ id: accountId }, readableAccounts(ctx, await territoryReadScope(ctx))] }, select: { id: true, ownerId: true } });
  if (!row) throw notFound();
  return row;
}

/**
 * 读取可见客户下的联系人（含客户负责人，用于编辑权限判断）。
 * Load a contact under a visible account (with the account owner for edit checks).
 */
async function requireContact(ctx: AuthContext, id: string) {
  const contact = await prisma.contact.findFirst({
    where: { id, organizationId: ctx.organizationId, account: visible(ctx) },
    include: { account: { select: { ownerId: true } } },
  });
  if (!contact) throw notFound();
  return contact;
}

/**
 * 联系人列表与导出共用的查询条件：所属客户可见（销售代表看自己负责客户及所在区域客户下的联系人）+ 筛选 + 搜索
 * （姓名、职位、电话、邮箱、客户名称）。
 * Query conditions shared by the contact list and export: visible account (sales reps see contacts of their own and their territories'
 * accounts) + filters + search (name, title, phone, email, account name).
 */
export function contactWhere(
  ctx: AuthContext,
  query: Omit<z.infer<typeof contactListSchema>, 'page' | 'pageSize'>,
  score?: Prisma.IntFilter,
  scope: string[] = [],
): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = {
    organizationId: ctx.organizationId,
    score,
    account: { AND: [readableAccounts(ctx, scope), query.ownerId ? { ownerId: query.ownerId } : {}] },
    accountId: query.accountId,
    isPrimary: query.isPrimary === undefined ? undefined : query.isPrimary === 'true',
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { title: c }, { phone: c }, { email: c }, { account: { name: c } }];
  }
  return where;
}

/**
 * 分页搜索全部可见联系人（最新在前）。
 * Search all visible contacts, newest first, paginated.
 */
export async function listAllContacts(ctx: AuthContext, query: z.infer<typeof contactListSchema>): Promise<Page<unknown>> {
  const where = contactWhere(ctx, query, await gradeRange(ctx.organizationId, 'CONTACT', query.grade), await territoryReadScope(ctx));
  const [items, total] = await prisma.$transaction([
    prisma.contact.findMany({ where, include: contactInclude, orderBy: scoreOrder<Prisma.ContactOrderByWithRelationInput>(query.sort, [{ createdAt: 'desc' }, { id: 'asc' }]), skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.contact.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 联系人详情（含所属客户与负责人）；不可见 404。
 * Contact detail with its account and owner; 404 when not visible.
 */
export async function getContact(ctx: AuthContext, id: string) {
  const contact = await prisma.contact.findFirst({ where: { id, organizationId: ctx.organizationId, account: readableAccounts(ctx, await territoryReadScope(ctx)) }, include: contactInclude });
  if (!contact) throw notFound();
  return contact;
}

/**
 * 客户的联系人列表。
 * Contacts of an account.
 */
export async function listContacts(ctx: AuthContext, accountId: string) {
  await requireAccount(ctx, accountId);
  return prisma.contact.findMany({ where: { organizationId: ctx.organizationId, accountId }, orderBy: contactOrder });
}

/**
 * 新建联系人；设为主要联系人时取消该客户其他主要联系人。
 * Create a contact; marking it primary clears other primary contacts of the account.
 */
export async function createContact(ctx: AuthContext, accountId: string, input: z.infer<typeof contactCreateSchema>) {
  // 联系人属于客户资料，按客户编辑权限判断 / contacts are part of the account: account edit rights apply
  assertCanUpdate(ctx, await requireAccount(ctx, accountId));
  const { custom, ...data } = input;
  const cf = await resolveCustom(ctx.organizationId, 'CONTACT', custom, null);
  return prisma.$transaction(async (tx) => {
    if (data.isPrimary) {
      await tx.contact.updateMany({ where: { organizationId: ctx.organizationId, accountId }, data: { isPrimary: false } });
    }
    const contact = await tx.contact.create({ data: { ...data, custom: cf.values as Prisma.InputJsonValue, organizationId: ctx.organizationId, accountId } });
    const customChanges = customDiff(cf.defs, null, cf.values);
    await audit(tx, { ...by(ctx), action: 'contact.create', entityType: 'contact', entityId: contact.id, changes: { after: snapshot('contact', contact), ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    return contact;
  });
}

/**
 * 更新联系人。
 * Update a contact.
 */
export async function updateContact(ctx: AuthContext, id: string, input: z.infer<typeof contactUpdateSchema>) {
  const { account, ...contact } = await requireContact(ctx, id);
  assertCanUpdate(ctx, account);
  const { custom, ...data } = input;
  const cf = custom === undefined ? null : await resolveCustom(ctx.organizationId, 'CONTACT', custom, contact.custom);
  return prisma.$transaction(async (tx) => {
    if (data.isPrimary) {
      await tx.contact.updateMany({
        where: { organizationId: ctx.organizationId, accountId: contact.accountId, id: { not: id } },
        data: { isPrimary: false },
      });
    }
    const updated = await tx.contact.update({ where: { id }, data: { ...data, ...(cf ? { custom: cf.values as Prisma.InputJsonValue } : {}) } });
    const fields = diff('contact', contact, updated);
    const customChanges = cf ? customDiff(cf.defs, contact.custom, cf.values) : {};
    if (Object.keys(fields).length || Object.keys(customChanges).length) {
      await audit(tx, { ...by(ctx), action: 'contact.update', entityType: 'contact', entityId: id, changes: { fields, ...(Object.keys(customChanges).length ? { custom: customChanges } : {}) } });
    }
    return updated;
  });
}

/**
 * 删除联系人。
 * Delete a contact.
 */
export async function deleteContact(ctx: AuthContext, id: string): Promise<void> {
  const { account, ...contact } = await requireContact(ctx, id);
  assertCanUpdate(ctx, account);
  await prisma.$transaction(async (tx) => {
    // 工单的联系人置空（工单保留）/ clear the contact on tickets (tickets are kept)
    const tickets = await tx.ticket.updateMany({ where: { organizationId: ctx.organizationId, contactId: id }, data: { contactId: null } });
    await tx.contact.delete({ where: { id } });
    await audit(tx, {
      ...by(ctx),
      action: 'contact.delete',
      entityType: 'contact',
      entityId: id,
      changes: { before: snapshot('contact', contact), ...(tickets.count ? { clearedTickets: tickets.count } : {}) },
    });
  });
}
