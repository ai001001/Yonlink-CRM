/**
 * 低库存提醒：定时任务（与定时工作流同一个定时器，每 15 分钟）检查启用的、设置了再订货水平的产品，
 * 库存不高于再订货水平且本次低库存尚未提醒时，给有 product.manage 的启用用户（管理员、经理）各发一条站内通知，
 * 点开即打开该产品的库存详情。库存回到再订货水平以上（或取消再订货水平、停用产品）后清除提醒标记，下次再降低时重新提醒。
 * 每个产品的提醒用条件更新加锁，多个进程同时运行时只提醒一次。
 * Low-stock alerts: the scheduled job (the workflow timer, every 15 minutes) checks active products with a reorder
 * level; when stock is at or below it and the current low spell has not been alerted, every active user with
 * product.manage (admins, managers) gets an in-app notification that opens the product's stock. Once stock recovers
 * above the level (or the level is cleared, or the product deactivated) the flag clears, so the next drop alerts again.
 * A conditional update guards each product, so concurrent runs alert once.
 */
import { NotificationType, UserRole } from '@/generated/prisma/enums';
import { prisma } from '../db';
import { ROLE_PERMISSIONS } from '../permissions';

/** 接收提醒的角色（拥有 product.manage）/ roles that receive alerts (holding product.manage) */
export const LOW_STOCK_ROLES = (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((r) => ROLE_PERMISSIONS[r].includes('product.manage'));

/**
 * 检查低库存并发送提醒。
 * Check low stock and send alerts.
 * @returns 恢复（清除标记）的产品数、提醒的产品数与发出的通知数 / products recovered, products alerted and notifications sent
 */
export async function sweepLowStock(opts: { organizationId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const org = opts.organizationId ?? null;
  // 恢复：库存回到再订货水平以上、取消再订货水平或停用 / recovered: above the level, no level, or inactive
  const recovered = await prisma.$executeRaw`
    UPDATE products SET low_stock_alerted_at = NULL
    WHERE low_stock_alerted_at IS NOT NULL AND (${org}::uuid IS NULL OR organization_id = ${org}::uuid)
      AND (reorder_level IS NULL OR stock_quantity > reorder_level OR NOT is_active)`;
  const candidates = await prisma.$queryRaw<{ id: string; organization_id: string; name: string; sku: string }[]>`
    SELECT id, organization_id, name, sku FROM products
    WHERE is_active AND reorder_level IS NOT NULL AND stock_quantity <= reorder_level AND low_stock_alerted_at IS NULL
      AND (${org}::uuid IS NULL OR organization_id = ${org}::uuid)
    ORDER BY organization_id, name, id`;
  let alerted = 0;
  let notifications = 0;
  for (const p of candidates) {
    notifications += await prisma.$transaction(async (tx) => {
      // 条件更新：只有第一个进程能标记 / conditional update: only the first run marks it
      const marked = await tx.$executeRaw`
        UPDATE products SET low_stock_alerted_at = ${now}
        WHERE id = ${p.id}::uuid AND low_stock_alerted_at IS NULL AND is_active AND reorder_level IS NOT NULL AND stock_quantity <= reorder_level`;
      if (!marked) return 0;
      alerted += 1;
      const users = await tx.user.findMany({ where: { organizationId: p.organization_id, isActive: true, role: { in: LOW_STOCK_ROLES } }, select: { id: true } });
      const { count } = await tx.notification.createMany({
        data: users.map((u) => ({
          organizationId: p.organization_id,
          userId: u.id,
          type: NotificationType.LOW_STOCK,
          productId: p.id,
          title: `${p.name} (${p.sku})`.slice(0, 200),
          dedupKey: `low_stock:${p.id}:${now.getTime()}`,
        })),
        skipDuplicates: true,
      });
      return count;
    });
  }
  return { recovered, checked: candidates.length, alerted, notifications };
}
