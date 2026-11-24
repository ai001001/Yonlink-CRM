/**
 * 仓库（对标 Zoho Inventory 的多仓库）：维护仓库，库存按仓库记录（产品总库存为各仓库之和）。
 * - 仓库：代码（自动转大写，同组织唯一）、名称、地址、启停；每组织一个默认仓库，未指定仓库的收货、发货与调整使用默认仓库。
 * - 维护需 product.manage（管理员、经理）并写审计；所有用户可查看。
 * - 默认仓库不能停用或取消默认（先把其他仓库设为默认）；有库存流水的仓库不能删除（可停用）；停用的仓库不能再收货、发货、调整或调入调出。
 * - 组织还没有仓库时，第一次产生库存流水会自动建立默认仓库（代码 MAIN）。
 * Warehouses (cf. Zoho Inventory multi-warehouse): stock is kept per warehouse and the product total is their sum.
 * Warehouses have an upper-cased code unique per organization, a name, an address and an active flag; one default per
 * organization handles receipts, shipments and adjustments without a warehouse. Maintenance needs product.manage
 * (admins, managers) and is audited; everyone can view. The default cannot be deactivated or un-defaulted (make another
 * one default first); warehouses with movements cannot be deleted (deactivate them); inactive warehouses take no new
 * movements. An organization without warehouses gets a default (code MAIN) with its first movement.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { optionalText, requiredText } from '../validation';

/** 自动建立的默认仓库 / the automatically created default warehouse */
export const DEFAULT_WAREHOUSE = { code: 'MAIN', name: '默认仓库' } as const;

const code = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_-]{1,20}$/, 'invalid_code'));
/** 新建 / create */
export const warehouseCreateSchema = z.strictObject({ code, name: requiredText(100), address: optionalText(500), isActive: z.boolean().default(true), isDefault: z.boolean().default(false) });
/** 修改 / update */
export const warehouseUpdateSchema = z.strictObject({ code, name: requiredText(100), address: optionalText(500), isActive: z.boolean(), isDefault: z.boolean() }).partial();

const select = { id: true, code: true, name: true, address: true, isActive: true, isDefault: true, createdAt: true } satisfies Prisma.WarehouseSelect;
const lock = (tx: Prisma.TransactionClient, org: string) => tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`warehouse:${org}`}, 0))`;

/**
 * 组织的默认仓库（没有时建立，在调用方事务内加锁）。
 * The organization's default warehouse (created when missing, under a lock in the caller's transaction).
 */
export async function ensureDefaultWarehouse(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  const found = await tx.warehouse.findFirst({ where: { organizationId, isDefault: true }, select: { id: true } });
  if (found) return found.id;
  await lock(tx, organizationId);
  const again = await tx.warehouse.findFirst({ where: { organizationId, isDefault: true }, select: { id: true } });
  if (again) return again.id;
  // 代码 MAIN 已被非默认仓库占用时，把那个仓库设为默认 / if MAIN exists but is not default, make it the default
  const main = await tx.warehouse.findUnique({ where: { organizationId_code: { organizationId, code: DEFAULT_WAREHOUSE.code } } });
  if (main) return (await tx.warehouse.update({ where: { id: main.id }, data: { isDefault: true, isActive: true }, select: { id: true } })).id;
  return (await tx.warehouse.create({ data: { organizationId, ...DEFAULT_WAREHOUSE, isDefault: true }, select: { id: true } })).id;
}

/**
 * 流水使用的仓库：指定的须为本组织启用仓库，未指定时用默认仓库。
 * The warehouse for a movement: a given one must be an active warehouse of the organization; otherwise the default.
 */
export async function resolveWarehouse(tx: Prisma.TransactionClient, organizationId: string, warehouseId: string | null | undefined, field = 'warehouseId'): Promise<{ id: string; code: string }> {
  if (!warehouseId) {
    const id = await ensureDefaultWarehouse(tx, organizationId);
    return tx.warehouse.findUniqueOrThrow({ where: { id }, select: { id: true, code: true } });
  }
  const w = await tx.warehouse.findFirst({ where: { id: warehouseId, organizationId }, select: { id: true, code: true, isActive: true } });
  if (!w) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown warehouse', { [field]: ['not_found'] });
  if (!w.isActive) throw new ApiError(409, 'CONFLICT', 'The warehouse is inactive', { [field]: ['inactive'] });
  return { id: w.id, code: w.code };
}

/**
 * 仓库列表（默认仓库在前，含有库存的产品数与库存件数合计）。
 * Warehouses (default first) with the number of stocked products and total units.
 */
export async function listWarehouses(ctx: AuthContext) {
  const [rows, stats] = await Promise.all([
    prisma.warehouse.findMany({ where: { organizationId: ctx.organizationId }, select, orderBy: [{ isDefault: 'desc' }, { isActive: 'desc' }, { code: 'asc' }] }),
    prisma.productStock.groupBy({ by: ['warehouseId'], where: { organizationId: ctx.organizationId, quantity: { not: 0 } }, _count: { _all: true }, _sum: { quantity: true } }),
  ]);
  return {
    items: rows.map((w) => {
      const s = stats.find((x) => x.warehouseId === w.id);
      return { ...w, products: s?._count._all ?? 0, units: (s?._sum.quantity ?? new Prisma.Decimal(0)).toString() };
    }),
  };
}

function codeTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Warehouse code already exists', { code: ['taken'] });
  throw err;
}

/**
 * 新建仓库（设为默认时取消原默认；组织的第一个仓库自动为默认）。
 * Create a warehouse (becoming default clears the old one; an organization's first warehouse is the default).
 */
export async function createWarehouse(ctx: AuthContext, input: z.infer<typeof warehouseCreateSchema>) {
  requirePermission(ctx, 'product.manage');
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      await lock(tx, org);
      const first = (await tx.warehouse.count({ where: { organizationId: org } })) === 0;
      const isDefault = input.isDefault || first;
      if (isDefault && !input.isActive) throw new ApiError(409, 'CONFLICT', 'The default warehouse must be active', { isActive: ['default_must_be_active'] });
      if (isDefault) await tx.warehouse.updateMany({ where: { organizationId: org, isDefault: true }, data: { isDefault: false } });
      const w = await tx.warehouse.create({ data: { ...input, isDefault, organizationId: org }, select });
      await audit(tx, { ...by(ctx), action: 'warehouse.create', entityType: 'warehouse', entityId: w.id, changes: { after: { code: w.code, name: w.name, isActive: w.isActive, isDefault: w.isDefault } } });
      return w;
    });
  } catch (err) {
    codeTaken(err);
  }
}

/**
 * 修改仓库：设为默认时取消原默认；默认仓库不能停用或取消默认。
 * Update a warehouse: becoming default clears the old one; the default cannot be deactivated or un-defaulted.
 */
export async function updateWarehouse(ctx: AuthContext, id: string, input: z.infer<typeof warehouseUpdateSchema>) {
  requirePermission(ctx, 'product.manage');
  const org = ctx.organizationId;
  try {
    return await prisma.$transaction(async (tx) => {
      await lock(tx, org);
      const current = await tx.warehouse.findFirst({ where: { id, organizationId: org }, select });
      if (!current) throw notFound();
      if (current.isDefault && input.isDefault === false) throw new ApiError(409, 'CONFLICT', 'Make another warehouse the default first', { isDefault: ['need_default'] });
      const isDefault = input.isDefault ?? current.isDefault;
      const isActive = input.isActive ?? current.isActive;
      if (isDefault && !isActive) throw new ApiError(409, 'CONFLICT', 'The default warehouse must be active', { isActive: ['default_must_be_active'] });
      if (input.isDefault && !current.isDefault) await tx.warehouse.updateMany({ where: { organizationId: org, isDefault: true }, data: { isDefault: false } });
      const w = await tx.warehouse.update({ where: { id }, data: input, select });
      const keys = ['code', 'name', 'address', 'isActive', 'isDefault'] as const;
      const fields = Object.fromEntries(keys.filter((k) => current[k] !== w[k]).map((k) => [k, [current[k], w[k]]]));
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'warehouse.update', entityType: 'warehouse', entityId: id, changes: { code: w.code, fields } });
      return w;
    });
  } catch (err) {
    codeTaken(err);
  }
}

/**
 * 删除仓库：默认仓库与有库存流水的仓库不能删除。
 * Delete a warehouse: the default and warehouses with movements cannot be deleted.
 */
export async function deleteWarehouse(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'product.manage');
  const org = ctx.organizationId;
  await prisma.$transaction(async (tx) => {
    await lock(tx, org);
    const w = await tx.warehouse.findFirst({ where: { id, organizationId: org }, select });
    if (!w) throw notFound();
    if (w.isDefault) throw new ApiError(409, 'CONFLICT', 'The default warehouse cannot be deleted', { isDefault: ['default'] });
    if (await tx.stockMovement.count({ where: { organizationId: org, warehouseId: id } })) throw new ApiError(409, 'CONFLICT', 'The warehouse has stock movements', { id: ['has_movements'] });
    await tx.productStock.deleteMany({ where: { warehouseId: id } });
    await tx.warehouse.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'warehouse.delete', entityType: 'warehouse', entityId: id, changes: { before: { code: w.code, name: w.name } } });
  });
}
