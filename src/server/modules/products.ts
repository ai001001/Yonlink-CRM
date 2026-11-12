/**
 * 产品目录应用服务。组织内所有用户可查看；仅拥有 product.manage 的角色（管理员、经理）可维护。
 * SKU 统一转为大写，组织内唯一（不区分大小写）；被商机使用的产品不能删除，只能停用。
 * Product catalog service: everyone in the organization can read; only roles with product.manage maintain it.
 * SKUs are upper-cased and unique per organization; products used by deals cannot be deleted, only deactivated.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { containsText, listQuery, optionalText, requiredText, type Page } from '../validation';
import { amountSchema, CURRENCIES } from './deals';

const fields = {
  sku: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'Invalid SKU')
    .transform((v) => v.toUpperCase()),
  name: requiredText(200),
  category: optionalText(50),
  unit: z.string().trim().min(1).max(20).default('件'),
  unitPrice: amountSchema.default('0'),
  currency: z.enum(CURRENCIES).default('CNY'),
  description: optionalText(5000),
  isActive: z.boolean().default(true),
};

/** 新建产品 / Create product */
export const productCreateSchema = z.strictObject(fields);
/** 更新产品 / Update product */
export const productUpdateSchema = z
  .strictObject({ ...fields, unit: z.string().trim().min(1).max(20), unitPrice: amountSchema, currency: z.enum(CURRENCIES), isActive: z.boolean() })
  .partial();
/** 列表查询 / List query */
export const productListSchema = listQuery.extend({
  active: z.enum(['true', 'false']).optional(),
  currency: z.enum(CURRENCIES).optional(),
});

/**
 * 分页搜索产品（SKU、名称、分类）。
 * Search products (SKU, name, category) with pagination.
 */
export async function listProducts(ctx: AuthContext, query: z.infer<typeof productListSchema>): Promise<Page<unknown>> {
  const where: Prisma.ProductWhereInput = {
    organizationId: ctx.organizationId,
    isActive: query.active === undefined ? undefined : query.active === 'true',
    currency: query.currency,
  };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ sku: c }, { name: c }, { category: c }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: { _count: { select: { lineItems: true } } },
      orderBy: [{ isActive: 'desc' }, { sku: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 产品详情；跨组织 404。
 * Product detail; 404 across organizations.
 */
export async function getProduct(ctx: AuthContext, id: string) {
  const product = await prisma.product.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { _count: { select: { lineItems: true } } } });
  if (!product) throw notFound();
  return product;
}

/**
 * 新建产品（SKU 重复返回 409）。
 * Create a product (duplicate SKU → 409).
 */
export async function createProduct(ctx: AuthContext, input: z.infer<typeof productCreateSchema>) {
  requirePermission(ctx, 'product.manage');
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({ data: { ...input, organizationId: ctx.organizationId } });
    await audit(tx, { ...by(ctx), action: 'product.create', entityType: 'product', entityId: product.id, changes: { after: snapshot('product', product) } });
    return product;
  });
}

/**
 * 更新产品（改价不影响已有明细，明细保存了当时的单价）。
 * Update a product (price changes do not affect existing line items, which keep their own price).
 */
export async function updateProduct(ctx: AuthContext, id: string, input: z.infer<typeof productUpdateSchema>) {
  requirePermission(ctx, 'product.manage');
  const current = await getProduct(ctx, id);
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.update({ where: { id: current.id }, data: input });
    const fields = diff('product', current, product);
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'product.update', entityType: 'product', entityId: id, changes: { fields } });
    return product;
  });
}

/**
 * 删除产品：已被商机明细使用时拒绝（409，请改为停用）。
 * Delete a product; refused with 409 when used by deal line items (deactivate instead).
 */
export async function deleteProduct(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'product.manage');
  const product = await getProduct(ctx, id);
  if (product._count.lineItems > 0) throw new ApiError(409, 'CONFLICT', 'Product is used by deals', { product: ['in_use'] });
  // 并发新增明细时，数据库 RESTRICT 外键仍会拒绝（P2003 → 409）/ the RESTRICT FK still blocks concurrent use
  await prisma.$transaction(async (tx) => {
    await tx.product.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'product.delete', entityType: 'product', entityId: id, changes: { before: snapshot('product', product) } });
  });
}
