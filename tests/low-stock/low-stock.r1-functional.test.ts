/**
 * 低库存提醒 第一轮：功能测试（库存降到再订货水平时提醒管理员与经理、同一次低库存只提醒一次、恢复后清除并可再次提醒、
 * 没有再订货水平或停用的产品不提醒、取消再订货水平与停用时清除、按组织处理、通知列表带产品、删除产品时通知随之删除、定时任务脚本输出）。
 * Low-stock alerts round 1: functional tests.
 */
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import * as productItem from '@/app/api/products/[id]/route';
import * as stock from '@/app/api/products/[id]/stock/route';
import * as products from '@/app/api/products/route';
import * as notifications from '@/app/api/notifications/route';
import { prisma } from '@/server/db';
import { LOW_STOCK_ROLES, sweepLowStock } from '@/server/modules/low-stock';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;
const newProduct = async (body: object, token = a.token) => (await call(products.POST, { token, body: { sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, name: '产品', ...body } })).json;
const setStock = (id: string, quantity: string, token = a.token) => call(stock.POST, { token, params: { id }, body: { mode: 'set', quantity, note: '盘点' } });
const alerts = (userId?: string) => prisma.notification.findMany({ where: { type: 'LOW_STOCK', ...(userId ? { userId } : {}) }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
  await addUser(a.org.id, 'READONLY', '只读');
});

describe('low stock R1', () => {
  it('提醒、只提醒一次、恢复后再次提醒；接收人为管理员与经理 / alert, once, again after recovery', async () => {
    expect(LOW_STOCK_ROLES.sort()).toEqual(['ADMIN', 'MANAGER']);
    const inactiveAdmin = await addUser(a.org.id, 'ADMIN', '停用管理员');
    await prisma.user.update({ where: { id: inactiveAdmin.user.id }, data: { isActive: false } });
    const p = await newProduct({ name: '涡轮增压器', sku: 'TB-01', reorderLevel: '10' });
    await setStock(p.id, '15');
    expect(await sweepLowStock()).toEqual({ recovered: 0, checked: 0, alerted: 0, notifications: 0 });
    await setStock(p.id, '10'); // 等于再订货水平即低库存 / at the level counts as low
    expect(await sweepLowStock()).toEqual({ recovered: 0, checked: 1, alerted: 1, notifications: 2 });
    const first = await alerts();
    expect(first.map((n) => n.userId).sort()).toEqual([a.user.id, mgr.user.id].sort());
    expect(first[0]).toMatchObject({ productId: p.id, title: '涡轮增压器 (TB-01)', actorId: null });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).lowStockAlertedAt).not.toBeNull();
    // 仍然低库存（继续减少）：不重复提醒 / still low: no repeat
    await setStock(p.id, '2');
    expect(await sweepLowStock()).toEqual({ recovered: 0, checked: 0, alerted: 0, notifications: 0 });
    // 恢复后清除，再降低时重新提醒 / recovery clears; the next drop alerts again
    await setStock(p.id, '30');
    expect((await sweepLowStock()).recovered).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).lowStockAlertedAt).toBeNull();
    await setStock(p.id, '0');
    expect((await sweepLowStock()).notifications).toBe(2);
    expect(await alerts(mgr.user.id)).toHaveLength(2);
    expect(await alerts(sales.user.id)).toHaveLength(0);
    // 通知列表带产品，文案类型正确 / the notification list carries the product
    const list = (await call(notifications.GET, { token: mgr.token })).json.items;
    expect(list[0]).toMatchObject({ type: 'LOW_STOCK', productId: p.id, title: '涡轮增压器 (TB-01)' });
  });

  it('没有再订货水平、停用产品不提醒；取消水平、停用时清除；按组织处理；删除产品时通知随之删除；脚本输出 / edge cases', async () => {
    const none = await newProduct({ name: '无水平' });
    await setStock(none.id, '0');
    const off = await newProduct({ name: '已停用', reorderLevel: '5', isActive: false });
    await setStock(off.id, '0');
    const x = await newProduct({ name: '会取消', reorderLevel: '5' });
    const y = await newProduct({ name: '会停用', reorderLevel: '5' });
    expect((await sweepLowStock()).alerted).toBe(2); // 库存 0 ≤ 5 / stock 0 is low
    expect((await alerts()).map((n) => n.productId).sort()).toEqual([x.id, x.id, y.id, y.id].sort());
    await call(productItem.PATCH, { token: a.token, params: { id: x.id }, body: { reorderLevel: null }, method: 'PATCH' });
    await call(productItem.PATCH, { token: a.token, params: { id: y.id }, body: { isActive: false }, method: 'PATCH' });
    expect((await sweepLowStock()).recovered).toBe(2);
    // 按组织 / per organization
    const b = await createTenant('B');
    const bp = await newProduct({ name: 'B 产品', reorderLevel: '5' }, b.token);
    expect((await sweepLowStock({ organizationId: a.org.id })).alerted).toBe(0);
    expect(await prisma.notification.count({ where: { organizationId: b.org.id } })).toBe(0);
    expect((await sweepLowStock({ organizationId: b.org.id })).notifications).toBe(1);
    expect((await prisma.notification.findFirstOrThrow({ where: { organizationId: b.org.id } })).userId).toBe(b.user.id);
    // 删除产品：通知随之删除 / deleting the product removes its alerts
    expect((await call(productItem.DELETE, { token: b.token, params: { id: bp.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.notification.count({ where: { organizationId: b.org.id } })).toBe(0);
    // 脚本：输出低库存一行 / the scheduled script prints the low-stock line
    const z = await newProduct({ name: '脚本', reorderLevel: '1' });
    void z;
    const out = execFileSync('npx', ['tsx', 'scripts/workflow-sweep.ts'], { env: process.env, encoding: 'utf8' });
    expect(out).toMatch(/低库存提醒完成 \/ low-stock alerts done: 低库存 1 个，新提醒 1 个产品，发出通知 2 条，恢复 0 个/);
  }, 60_000);
});
