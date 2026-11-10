/**
 * 客户与联系人应用服务。联系人作为客户的子数据管理。
 * Accounts & contacts application service. Contacts are managed as account children.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
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

const listInclude = {
  owner: { select: { id: true, name: true } },
  _count: { select: { contacts: true, deals: true } },
} satisfies Prisma.AccountInclude;

const contactOrder: Prisma.ContactOrderByWithRelationInput[] = [{ isPrimary: 'desc' }, { createdAt: 'asc' }];

/**
 * 分页搜索客户（名称、电话、网站、地址、联系人姓名）。
 * Search accounts with pagination (name, phone, website, address, contact name).
 */
export async function listAccounts(ctx: AuthContext, query: z.infer<typeof accountListSchema>): Promise<Page<unknown>> {
  const where: Prisma.AccountWhereInput = {
    organizationId: ctx.organizationId,
    industry: query.industry,
    ownerId: query.ownerId,
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { phone: c }, { website: c }, { address: c }, { contacts: { some: { name: c } } }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.account.findMany({
      where,
      include: listInclude,
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
    where: { id, organizationId: ctx.organizationId },
    include: { ...listInclude, contacts: { orderBy: contactOrder } },
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
  const created = await prisma.account.create({
    data: { ...data, organizationId: ctx.organizationId, ownerId: await resolveOwner(ctx.organizationId, ownerId, ctx.userId) },
  });
  return getAccount(ctx, created.id);
}

/**
 * 更新客户。
 * Update an account.
 */
export async function updateAccount(ctx: AuthContext, id: string, input: z.infer<typeof accountUpdateSchema>) {
  const current = await getAccount(ctx, id);
  const { ownerId, ...data } = input;
  await prisma.account.update({
    where: { id: current.id },
    data: { ...data, ownerId: await resolveOwner(ctx.organizationId, ownerId, current.ownerId) },
  });
  return getAccount(ctx, id);
}

/**
 * 删除客户：联系人与跟进记录级联删除；存在商机时拒绝（409）。
 * Delete an account: contacts and activities cascade; refused with 409 while deals exist.
 */
export async function deleteAccount(ctx: AuthContext, id: string): Promise<void> {
  const account = await getAccount(ctx, id);
  if (account._count.deals > 0) {
    throw new ApiError(409, 'CONFLICT', 'Account has deals', { deals: [String(account._count.deals)] });
  }
  // 若并发新建了商机，数据库 RESTRICT 外键仍会拒绝（P2003 → 409）
  // a concurrently created deal is still blocked by the RESTRICT FK (P2003 → 409)
  await prisma.account.delete({ where: { id: account.id } });
}

/**
 * 读取本组织客户 ID，不存在时 404。
 * Load an account id within the organization or throw 404.
 */
async function requireAccount(ctx: AuthContext, accountId: string): Promise<string> {
  const row = await prisma.account.findFirst({ where: { id: accountId, organizationId: ctx.organizationId }, select: { id: true } });
  if (!row) throw notFound();
  return row.id;
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
  await requireAccount(ctx, accountId);
  return prisma.$transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.contact.updateMany({ where: { organizationId: ctx.organizationId, accountId }, data: { isPrimary: false } });
    }
    return tx.contact.create({ data: { ...input, organizationId: ctx.organizationId, accountId } });
  });
}

/**
 * 更新联系人。
 * Update a contact.
 */
export async function updateContact(ctx: AuthContext, id: string, input: z.infer<typeof contactUpdateSchema>) {
  const contact = await prisma.contact.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!contact) throw notFound();
  return prisma.$transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.contact.updateMany({
        where: { organizationId: ctx.organizationId, accountId: contact.accountId, id: { not: id } },
        data: { isPrimary: false },
      });
    }
    return tx.contact.update({ where: { id }, data: input });
  });
}

/**
 * 删除联系人。
 * Delete a contact.
 */
export async function deleteContact(ctx: AuthContext, id: string): Promise<void> {
  const { count } = await prisma.contact.deleteMany({ where: { id, organizationId: ctx.organizationId } });
  if (count === 0) throw notFound();
}
