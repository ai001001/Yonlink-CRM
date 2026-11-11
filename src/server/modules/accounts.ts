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
import { detachSharedActivities } from './activities';
import { containsText, listQuery, optionalEmail, optionalText, optionalUuid, requiredText, resolveOwner, type Page } from '../validation';

/** 行业字典 / Industry dictionary */
export const INDUSTRIES = [
  'MANUFACTURING',
  'IT',
  'FINANCE',
  'RETAIL',
  'EDUCATION',
  'HEALTHCARE',
  'CONSTRUCTION',
  'LOGISTICS',
  'GOVERNMENT',
  'OTHER',
] as const;

const accountFields = {
  name: requiredText(200),
  industry: z.enum(INDUSTRIES).nullish().transform((v) => v ?? null),
  phone: optionalText(50),
  website: optionalText(254),
  address: optionalText(500),
  description: optionalText(5000),
  ownerId: optionalUuid.optional(),
};

/** 新建客户 / Create account */
export const accountCreateSchema = z.strictObject(accountFields);
/** 更新客户 / Update account */
export const accountUpdateSchema = accountCreateSchema.partial();
/** 客户列表查询 / Account list query */
export const accountListSchema = listQuery.extend({
  industry: z.enum(INDUSTRIES).optional(),
  ownerId: z.uuid().optional(),
});

const contactFields = {
  name: requiredText(100),
  title: optionalText(100),
  phone: optionalText(50),
  email: optionalEmail,
  isPrimary: z.boolean().default(false),
};
/** 新建联系人 / Create contact */
export const contactCreateSchema = z.strictObject(contactFields);
/** 更新联系人 / Update contact */
export const contactUpdateSchema = z.strictObject({ ...contactFields, isPrimary: z.boolean() }).partial();

/**
 * 客户返回内容；商机数与商机列表遵循相同可见范围（销售代表只统计自己负责的商机）。
 * Account include; the deal count follows the same visibility as the deals list (sales reps count only their own).
 */
function listInclude(ctx: AuthContext) {
  const dealScope: Prisma.DealWhereInput = can(ctx, 'record.read.all') ? {} : { ownerId: ctx.userId };
  return {
    owner: { select: { id: true, name: true } },
    _count: { select: { contacts: true, deals: { where: dealScope } } },
  } satisfies Prisma.AccountInclude;
}

const contactOrder: Prisma.ContactOrderByWithRelationInput[] = [{ isPrimary: 'desc' }, { createdAt: 'asc' }];

/**
 * 列表与导出共用的查询条件（可见范围 + 筛选 + 搜索）。
 * Query conditions shared by the list and the export (visibility + filters + search).
 */
export function accountWhere(ctx: AuthContext, query: Omit<z.infer<typeof accountListSchema>, 'page' | 'pageSize'>): Prisma.AccountWhereInput {
  const where: Prisma.AccountWhereInput = { AND: [visible(ctx), { industry: query.industry, ownerId: query.ownerId }] };
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
  const where = accountWhere(ctx, query);
  const [items, total] = await prisma.$transaction([
    prisma.account.findMany({
      where,
      include: listInclude(ctx),
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
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
  const account = await prisma.account.findFirst({
    where: { id, ...visible(ctx) },
    include: { ...listInclude(ctx), contacts: { orderBy: contactOrder } },
  });
  if (!account) throw notFound();
  return account;
}

/**
 * 新建客户。
 * Create an account.
 */
export async function createAccount(ctx: AuthContext, input: z.infer<typeof accountCreateSchema>) {
  const { ownerId, ...data } = input;
  requirePermission(ctx, 'record.create');
  assertOwnerAssignable(ctx, ownerId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, ctx.userId);
  const created = await prisma.$transaction(async (tx) => {
    const account = await tx.account.create({ data: { ...data, organizationId: ctx.organizationId, ownerId: owner } });
    await audit(tx, { ...by(ctx), action: 'account.create', entityType: 'account', entityId: account.id, changes: { after: snapshot('account', account) } });
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
  const { ownerId, ...data } = input;
  assertOwnerAssignable(ctx, ownerId);
  const owner = await resolveOwner(ctx.organizationId, ownerId, current.ownerId);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.account.update({ where: { id: current.id }, data: { ...data, ownerId: owner } });
    const fields = diff('account', current, updated);
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'account.update', entityType: 'account', entityId: id, changes: { fields } });
    }
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
  // 若并发新建了商机，数据库 RESTRICT 外键仍会拒绝（P2003 → 409）
  // a concurrently created deal is still blocked by the RESTRICT FK (P2003 → 409)
  await prisma.$transaction(async (tx) => {
    await detachSharedActivities(tx, ctx.organizationId, 'accountId', account.id);
    await tx.account.delete({ where: { id: account.id } });
    await audit(tx, {
      ...by(ctx),
      action: 'account.delete',
      entityType: 'account',
      entityId: account.id,
      // 联系人随客户级联删除，记录数量 / contacts cascade with the account; record how many
      changes: { before: snapshot('account', account), cascadedContacts: account._count.contacts },
    });
  });
}

/**
 * 读取当前用户可见的客户，不可见时 404。
 * Load an account visible to the user or throw 404.
 */
async function requireAccount(ctx: AuthContext, accountId: string): Promise<{ id: string; ownerId: string | null }> {
  const row = await prisma.account.findFirst({ where: { id: accountId, ...visible(ctx) }, select: { id: true, ownerId: true } });
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
  return prisma.$transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.contact.updateMany({ where: { organizationId: ctx.organizationId, accountId }, data: { isPrimary: false } });
    }
    const contact = await tx.contact.create({ data: { ...input, organizationId: ctx.organizationId, accountId } });
    await audit(tx, { ...by(ctx), action: 'contact.create', entityType: 'contact', entityId: contact.id, changes: { after: snapshot('contact', contact) } });
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
  return prisma.$transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.contact.updateMany({
        where: { organizationId: ctx.organizationId, accountId: contact.accountId, id: { not: id } },
        data: { isPrimary: false },
      });
    }
    const updated = await tx.contact.update({ where: { id }, data: input });
    const fields = diff('contact', contact, updated);
    if (Object.keys(fields).length) {
      await audit(tx, { ...by(ctx), action: 'contact.update', entityType: 'contact', entityId: id, changes: { fields } });
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
    await tx.contact.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'contact.delete', entityType: 'contact', entityId: id, changes: { before: snapshot('contact', contact) } });
  });
}
