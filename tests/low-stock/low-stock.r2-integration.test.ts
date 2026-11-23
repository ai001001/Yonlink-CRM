/**
 * 低库存提醒 第二轮：集成测试（3 个进程并发：每个产品只提醒一次；2000 个产品的耗时；数据库约束；演示数据的低库存提醒）。
 * Low-stock alerts round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import { prisma } from '@/server/db';
import { sweepLowStock } from '@/server/modules/low-stock';
import { addUser, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

/** 直接写入 n 个库存为 0、再订货水平为 5 的产品 / insert n products with stock 0 and level 5 */
const lowProducts = (org: string, n: number, prefix = 'P') =>
  prisma.product.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: org, sku: `${prefix}-${i}`, name: `${prefix}${i}`, reorderLevel: '5' })) });

describe('low stock R2', () => {
  it('3 个进程并发：每个产品只提醒一次 / concurrent sweeps alert once', async () => {
    await addUser(a.org.id, 'MANAGER', '经理');
    await lowProducts(a.org.id, 50);
    const results = await Promise.all([sweepLowStock(), sweepLowStock(), sweepLowStock()]);
    expect(results.reduce((s, r) => s + r.alerted, 0)).toBe(50);
    expect(results.reduce((s, r) => s + r.notifications, 0)).toBe(100);
    expect(await prisma.notification.count({ where: { type: 'LOW_STOCK' } })).toBe(100);
    const perProduct = await prisma.notification.groupBy({ by: ['productId'], _count: { _all: true } });
    expect(perProduct.every((g) => g._count._all === 2)).toBe(true);
  });

  it('2000 个产品；数据库约束 / scale and constraints', async () => {
    await lowProducts(a.org.id, 2000);
    const t0 = Date.now();
    expect(await sweepLowStock()).toMatchObject({ checked: 2000, alerted: 2000, notifications: 2000 });
    expect(Date.now() - t0).toBeLessThan(90_000);
    expect((await sweepLowStock()).checked).toBe(0);
    const p = await prisma.product.findFirstOrThrow({ where: { organizationId: a.org.id } });
    const n = await prisma.notification.findFirstOrThrow({ where: { productId: p.id } });
    // 再指向一条线索（两个目标）被拒绝 / pointing at a lead as well (two targets) is refused
    await expect(prisma.$executeRaw`UPDATE notifications SET lead_id = ${n.id}::uuid WHERE id = ${n.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE notifications SET product_id = NULL WHERE id = ${n.id}::uuid`).rejects.toThrow(/notifications_one_target_check/);
    const b = await createTenant('B');
    await expect(prisma.notification.create({ data: { organizationId: b.org.id, userId: b.user.id, type: 'LOW_STOCK', productId: p.id, title: 'x' } })).rejects.toThrow();
  }, 180_000);

  it('演示数据：低库存产品提醒演示管理员与经理 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const low = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE organization_id = ${org.id}::uuid AND is_active AND reorder_level IS NOT NULL AND stock_quantity <= reorder_level`;
    expect(low.length).toBeGreaterThan(0);
    const r = await sweepLowStock({ organizationId: org.id });
    const recipients = await prisma.user.count({ where: { organizationId: org.id, isActive: true, role: { in: ['ADMIN', 'MANAGER'] } } });
    expect(r).toMatchObject({ checked: low.length, alerted: low.length, notifications: low.length * recipients });
    const users = await prisma.notification.findMany({ where: { organizationId: org.id, type: 'LOW_STOCK' }, select: { user: { select: { role: true } } } });
    expect(new Set(users.map((u) => u.user.role))).toEqual(new Set(['ADMIN', 'MANAGER']));
  });
});
