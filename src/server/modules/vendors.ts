/**
 * 供应商（对标 Zoho Vendors）：采购单的供货方。
 * - 查看需 purchase.read（管理员、经理、只读用户）；新建、修改、删除需 purchase.manage（管理员、经理）。
 * - 组织内名称唯一（不区分大小写）；有采购单的供应商不能删除（可停用，停用后不能用于新采购单）。
 * - 新建、修改、删除写审计（电话、邮箱打码，地址与备注只记“已修改”）。
 * Vendors (cf. Zoho Vendors): suppliers on purchase orders. Viewing needs purchase.read (admins, managers, read-only
 * users); create, update and delete need purchase.manage (admins, managers). Names are unique per organization
 * (case-insensitive); vendors with purchase orders cannot be deleted (deactivate them instead; inactive vendors cannot
 * be used on new orders). Changes are audited with masked contact details and redacted address and notes.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { containsText, listQuery, optionalEmail, optionalText, requiredText, type Page } from '../validation';
import { CURRENCIES } from './deals';

const fields = {
  name: requiredText(200),
  contactName: optionalText(100),
  phone: optionalText(50),
  email: optionalEmail,
  website: optionalText(200),
  address: optionalText(500),
  currency: z.enum(CURRENCIES).default('CNY'),
  paymentTerms: optionalText(100),
  notes: optionalText(5000),
  isActive: z.boolean().default(true),
};

/** 新建供应商 / Create a vendor */
export const vendorCreateSchema = z.strictObject(fields);
/** 修改供应商 / Update a vendor */
export const vendorUpdateSchema = z.strictObject({ ...fields, currency: z.enum(CURRENCIES), isActive: z.boolean() }).partial();
/** 列表查询 / List query */
export const vendorListSchema = listQuery.extend({ active: z.enum(['true', 'false']).optional() });

const include = { _count: { select: { purchaseOrders: true } } } satisfies Prisma.VendorInclude;

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Vendor name already exists', { name: ['taken'] });
  throw err;
}

/**
 * 分页搜索供应商（名称、联系人、电话、邮箱）。
 * Search vendors (name, contact, phone, email), paginated.
 */
export async function listVendors(ctx: AuthContext, query: z.infer<typeof vendorListSchema>): Promise<Page<unknown>> {
  requirePermission(ctx, 'purchase.read');
  const where: Prisma.VendorWhereInput = { organizationId: ctx.organizationId, isActive: query.active === undefined ? undefined : query.active === 'true' };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { contactName: c }, { phone: c }, { email: c }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.vendor.findMany({ where, include, orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.vendor.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 供应商详情（含最近 20 张采购单）。
 * Vendor detail with the 20 latest purchase orders.
 */
export async function getVendor(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'purchase.read');
  const vendor = await prisma.vendor.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      ...include,
      purchaseOrders: { select: { id: true, poNumber: true, subject: true, status: true, currency: true, total: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  if (!vendor) throw notFound();
  return vendor;
}

/**
 * 新建供应商。
 * Create a vendor.
 */
export async function createVendor(ctx: AuthContext, input: z.infer<typeof vendorCreateSchema>) {
  requirePermission(ctx, 'purchase.manage');
  try {
    return await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({ data: { ...input, organizationId: ctx.organizationId }, include });
      await audit(tx, { ...by(ctx), action: 'vendor.create', entityType: 'vendor', entityId: vendor.id, changes: { after: snapshot('vendor', vendor) } });
      return vendor;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 修改供应商。
 * Update a vendor.
 */
export async function updateVendor(ctx: AuthContext, id: string, input: z.infer<typeof vendorUpdateSchema>) {
  requirePermission(ctx, 'purchase.manage');
  const current = await prisma.vendor.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!current) throw notFound();
  try {
    return await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.update({ where: { id }, data: input, include });
      const fields = diff('vendor', current, vendor);
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'vendor.update', entityType: 'vendor', entityId: id, changes: { fields } });
      return vendor;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除供应商（有采购单时 409，请改为停用）。
 * Delete a vendor (409 when it has purchase orders; deactivate it instead).
 */
export async function deleteVendor(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'purchase.manage');
  const current = await prisma.vendor.findFirst({ where: { id, organizationId: ctx.organizationId }, include });
  if (!current) throw notFound();
  if (current._count.purchaseOrders > 0) throw new ApiError(409, 'CONFLICT', 'Vendor has purchase orders', { purchaseOrders: [String(current._count.purchaseOrders)] });
  // 并发新建采购单时 RESTRICT 外键仍会拒绝（P2003 → 409）/ the RESTRICT FK still blocks a concurrent order
  await prisma.$transaction(async (tx) => {
    await tx.vendor.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'vendor.delete', entityType: 'vendor', entityId: id, changes: { before: snapshot('vendor', current) } });
  });
}
