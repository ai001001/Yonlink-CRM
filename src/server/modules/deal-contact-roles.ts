/**
 * 商机联系人角色应用服务（对标 Zoho Contact Roles）。
 * - 联系人必须属于商机的客户；同一商机中一个联系人只出现一次；每个商机最多一个主要联系人。
 * - 查看需能看到商机；增删改需能编辑商机；写操作在商机审计中记录。
 * - 商机换客户时，不属于新客户的联系人角色在同一事务内移除（见 removeStaleRoles）。
 * Deal contact roles (cf. Zoho): the contact belongs to the deal's account and appears once per deal; at most one
 * primary contact per deal. Viewing needs the deal to be visible; changes need edit rights on the deal and are
 * audited on the deal. When the deal moves to another account, roles of contacts outside it are removed in the
 * same transaction (see removeStaleRoles).
 */
import { z } from 'zod';
import { DealContactRoleType, Prisma } from '@/generated/prisma/client';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, visible } from '../permissions';

/** 角色取值 / Role values */
export const CONTACT_ROLES = Object.values(DealContactRoleType) as [DealContactRoleType, ...DealContactRoleType[]];

/** 新增联系人角色 / Add a contact role */
export const contactRoleCreateSchema = z.strictObject({
  contactId: z.uuid(),
  role: z.enum(CONTACT_ROLES),
  isPrimary: z.boolean().default(false),
});
/** 修改联系人角色（不能换联系人）/ Update a contact role (the contact cannot change) */
export const contactRoleUpdateSchema = z
  .strictObject({ role: z.enum(CONTACT_ROLES), isPrimary: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'No changes');

/** 联系人展示字段 / Contact fields shown with a role */
const contactSelect = { id: true, name: true, title: true, phone: true, email: true } as const;

/**
 * 读取可见商机（负责人与客户）。
 * Load a visible deal (owner and account).
 */
async function requireDeal(ctx: AuthContext, dealId: string) {
  const deal = await prisma.deal.findFirst({ where: { id: dealId, ...visible(ctx) }, select: { id: true, ownerId: true, accountId: true } });
  if (!deal) throw notFound();
  return deal;
}

/**
 * 在事务内锁定商机行并返回当前客户（与改客户的更新串行，避免角色指向其他客户的联系人）。
 * Lock the deal row inside the transaction and return its current account (serialises with account changes).
 */
async function lockDealAccount(tx: Prisma.TransactionClient, organizationId: string, dealId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ account_id: string }[]>`
    SELECT account_id::text FROM deals WHERE organization_id = ${organizationId}::uuid AND id = ${dealId}::uuid FOR UPDATE`;
  if (!rows[0]) throw notFound();
  return rows[0].account_id;
}

/**
 * 唯一约束冲突 → 409。
 * Unique violation → 409.
 */
function conflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    // 主要联系人并发冲突 / concurrent primary contact
    if (JSON.stringify(err.meta ?? {}).includes('primary')) throw new ApiError(409, 'CONFLICT', 'Primary contact changed concurrently', { isPrimary: ['conflict'] });
    throw new ApiError(409, 'CONFLICT', 'Contact already has a role', { contactId: ['duplicate'] });
  }
  throw err;
}

/**
 * 商机的联系人角色，以及该商机客户下还可添加的联系人。
 * Contact roles of a deal and the contacts of its account that can still be added.
 */
export async function listContactRoles(ctx: AuthContext, dealId: string) {
  const deal = await requireDeal(ctx, dealId);
  const [roles, contacts] = await Promise.all([
    prisma.dealContactRole.findMany({
      where: { organizationId: ctx.organizationId, dealId },
      include: { contact: { select: contactSelect } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.contact.findMany({
      where: { organizationId: ctx.organizationId, accountId: deal.accountId },
      select: { id: true, name: true, title: true },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const used = new Set(roles.map((r) => r.contactId));
  return { roles, contacts: contacts.filter((c) => !used.has(c.id)) };
}

/**
 * 新增联系人角色；设为主要联系人时取消该商机其他主要联系人。
 * Add a contact role; marking it primary clears the other primary role of the deal.
 */
export async function addContactRole(ctx: AuthContext, dealId: string, input: z.infer<typeof contactRoleCreateSchema>) {
  assertCanUpdate(ctx, await requireDeal(ctx, dealId));
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      const accountId = await lockDealAccount(tx, org, dealId);
      const contact = await tx.contact.findFirst({ where: { id: input.contactId, organizationId: org }, select: { id: true, name: true, accountId: true } });
      if (!contact) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid contact', { contactId: ['not_found'] });
      if (contact.accountId !== accountId) throw new ApiError(400, 'VALIDATION_ERROR', 'Contact belongs to another account', { contactId: ['other_account'] });
      if (input.isPrimary) await tx.dealContactRole.updateMany({ where: { organizationId: org, dealId, isPrimary: true }, data: { isPrimary: false } });
      const role = await tx.dealContactRole.create({
        data: { organizationId: org, dealId, contactId: contact.id, role: input.role, isPrimary: input.isPrimary },
        include: { contact: { select: contactSelect } },
      });
      await audit(tx, { ...by(ctx), action: 'deal.add_contact_role', entityType: 'deal', entityId: dealId, changes: { contact: contact.name, contactRole: role.role, isPrimary: role.isPrimary } });
      return role;
    });
  } catch (err) {
    conflict(err);
  }
}

/**
 * 读取联系人角色（所属商机必须可见）。
 * Load a contact role whose deal is visible.
 */
async function requireRole(ctx: AuthContext, id: string) {
  const role = await prisma.dealContactRole.findFirst({
    where: { id, organizationId: ctx.organizationId, deal: visible(ctx) },
    include: { deal: { select: { id: true, ownerId: true } }, contact: { select: { name: true } } },
  });
  if (!role) throw notFound();
  return role;
}

/**
 * 修改角色或主要联系人标记。
 * Change the role or the primary flag.
 */
export async function updateContactRole(ctx: AuthContext, id: string, input: z.infer<typeof contactRoleUpdateSchema>) {
  const current = await requireRole(ctx, id);
  assertCanUpdate(ctx, current.deal);
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.dealContactRole.updateMany({ where: { organizationId: org, dealId: current.dealId, isPrimary: true, id: { not: id } }, data: { isPrimary: false } });
      }
      const { count } = await tx.dealContactRole.updateMany({ where: { id, organizationId: org }, data: input });
      if (!count) throw notFound();
      const role = await tx.dealContactRole.findUniqueOrThrow({ where: { id }, include: { contact: { select: contactSelect } } });
      const fields: Record<string, [unknown, unknown]> = {};
      if (role.role !== current.role) fields.contactRole = [current.role, role.role];
      if (role.isPrimary !== current.isPrimary) fields.isPrimary = [current.isPrimary, role.isPrimary];
      if (Object.keys(fields).length) {
        await audit(tx, { ...by(ctx), action: 'deal.update_contact_role', entityType: 'deal', entityId: current.dealId, changes: { contact: current.contact.name, fields } });
      }
      return role;
    });
  } catch (err) {
    conflict(err);
  }
}

/**
 * 移除联系人角色（不删除联系人本身）。
 * Remove a contact role (the contact itself is kept).
 */
export async function removeContactRole(ctx: AuthContext, id: string): Promise<void> {
  const current = await requireRole(ctx, id);
  assertCanUpdate(ctx, current.deal);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.dealContactRole.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (!count) throw notFound();
    await audit(tx, { ...by(ctx), action: 'deal.remove_contact_role', entityType: 'deal', entityId: current.dealId, changes: { contact: current.contact.name, contactRole: current.role } });
  });
}

/**
 * 商机换客户后（同一事务内）移除不属于新客户的联系人角色，并逐条写审计。
 * After a deal moves to another account (same transaction), remove roles of contacts outside it and audit each.
 * @returns 移除的数量 / number of removed roles
 */
export async function removeStaleRoles(tx: Prisma.TransactionClient, ctx: AuthContext, dealId: string, accountId: string): Promise<number> {
  const stale = await tx.dealContactRole.findMany({
    where: { organizationId: ctx.organizationId, dealId, contact: { accountId: { not: accountId } } },
    include: { contact: { select: { name: true } } },
  });
  if (!stale.length) return 0;
  await tx.dealContactRole.deleteMany({ where: { organizationId: ctx.organizationId, id: { in: stale.map((r) => r.id) } } });
  for (const r of stale) {
    await audit(tx, { ...by(ctx), action: 'deal.remove_contact_role', entityType: 'deal', entityId: dealId, changes: { contact: r.contact.name, contactRole: r.role, via: 'deal.update' } });
  }
  return stale.length;
}
