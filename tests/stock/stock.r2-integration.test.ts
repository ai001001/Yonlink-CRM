/**
 * 产品库存 第二轮：集成测试（20 个并发调整：库存与余额连续；增减与盘点并发后库存 = 流水之和；组织隔离与跨组织单据被触发器拒绝；
 * 数据库约束与只增不改；删除销售订单时流水保留、单据置空；演示数据库存与流水一致、有低库存与缺货示例；2000 条流水分页查询耗时）。
 * Product stock round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as stockRoute from '@/app/api/products/[id]/stock/route';
import * as products from '@/app/api/products/route';
import * as summary from '@/app/api/products/stock-summary/route';
import { prisma } from '@/server/db';
import { stockSummary } from '@/server/modules/stock';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let p: { id: string };
const adjust = (body: object, id = p.id, token = a.token) => call(stockRoute.POST, { token, params: { id }, body });
/** 库存是否等于流水之和 / whether stock equals the sum of movements */
async function consistent(organizationId: string) {
  const rows = await prisma.$queryRaw<{ sku: string; stock: string; total: string }[]>`
    SELECT p.sku, p.stock_quantity::text AS stock, coalesce(sum(m.quantity), 0)::text AS total
    FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
    WHERE p.organization_id = ${organizationId}::uuid GROUP BY p.id`;
  return rows.filter((r) => Number(r.stock) !== Number(r.total));
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '增压器' } })).json;
});

describe('stock R2 concurrency', () => {
  it('20 个并发 +1：库存 20，余额 1–20 各一次 / concurrent additions', async () => {
    const res = await Promise.all(Array.from({ length: 20 }, () => adjust({ mode: 'add', quantity: '1', note: '并发' })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQuantity.toString()).toBe('20');
    const balances = (await prisma.stockMovement.findMany({ where: { productId: p.id } })).map((m) => Number(m.balanceAfter)).sort((x, y) => x - y);
    expect(balances).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('增减与盘点并发：库存 = 流水之和，盘点后的余额等于盘点数量 / mixed concurrency', async () => {
    await adjust({ mode: 'add', quantity: '100', note: '期初' });
    const jobs = Array.from({ length: 15 }, (_, i) => (i % 5 === 0 ? adjust({ mode: 'set', quantity: String(50 + i), note: '盘点' }) : adjust({ mode: 'add', quantity: i % 2 ? '-3' : '2', note: '变动' })));
    const res = await Promise.all(jobs);
    expect(res.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(await consistent(a.org.id)).toEqual([]);
    for (const m of await prisma.stockMovement.findMany({ where: { productId: p.id, note: '盘点' } })) {
      expect([50, 55, 60]).toContain(Number(m.balanceAfter));
    }
  });
});

describe('stock R2 isolation and database', () => {
  it('组织隔离；跨组织单据被拒绝；约束与只增不改；删除订单时流水保留 / isolation and guards', async () => {
    const b = await createTenant('B');
    const bp = (await call(products.POST, { token: b.token, body: { sku: 'P-1', name: 'B 产品' } })).json;
    await adjust({ mode: 'add', quantity: '5', note: 'x' });
    expect((await call(summary.GET, { token: b.token })).json).toEqual({ low: 0, out: 1 });
    expect((await call(stockRoute.GET, { token: b.token, params: { id: p.id } })).status).toBe(404);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: bp.id } })).stockQuantity.toString()).toBe('0');
    // 跨组织产品或单据 / cross-org product or orders
    await expect(prisma.stockMovement.create({ data: { organizationId: b.org.id, productId: p.id, reason: 'ADJUSTMENT', quantity: 1 } })).rejects.toThrow();
    const vendor = await prisma.vendor.create({ data: { organizationId: a.org.id, name: 'V' } });
    const po = await prisma.purchaseOrder.create({ data: { organizationId: a.org.id, vendorId: vendor.id, poNumber: 'PO-X-1', subject: 's', currency: 'CNY', subtotal: 0, taxAmount: 0, total: 0 } });
    await expect(prisma.stockMovement.create({ data: { organizationId: b.org.id, productId: bp.id, reason: 'PURCHASE_RECEIPT', quantity: 1, purchaseOrderId: po.id } })).rejects.toThrow(/Foreign key constraint/);
    // 触发器以外键错误码（23503）拒绝，Prisma 报告为外键约束错误 / the trigger rejects with 23503, reported by Prisma as a foreign-key error
    // 约束 / constraints
    await expect(prisma.stockMovement.create({ data: { organizationId: a.org.id, productId: p.id, reason: 'ADJUSTMENT', quantity: 0 } })).rejects.toThrow(/stock_movements_check/);
    await expect(prisma.stockMovement.create({ data: { organizationId: a.org.id, productId: p.id, reason: 'ADJUSTMENT', quantity: 1, note: '  ' } })).rejects.toThrow(/stock_movements_check/);
    const m = await prisma.stockMovement.findFirstOrThrow({ where: { productId: p.id } });
    await expect(prisma.$executeRaw`UPDATE stock_movements SET quantity = 9 WHERE id = ${m.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE products SET reorder_level = -1 WHERE id = ${p.id}::uuid`).rejects.toThrow(/products_reorder_level_check/);
    await expect(prisma.product.delete({ where: { id: p.id } })).rejects.toThrow();
    // 采购单被删除时流水保留、单据置空 / deleting the order keeps the movement and clears the reference
    const r = await prisma.stockMovement.create({ data: { organizationId: a.org.id, productId: p.id, reason: 'PURCHASE_RECEIPT', quantity: 2, purchaseOrderId: po.id } });
    expect(r.balanceAfter.toString()).toBe('7');
    await prisma.purchaseOrder.delete({ where: { id: po.id } });
    expect((await prisma.stockMovement.findUniqueOrThrow({ where: { id: r.id } })).purchaseOrderId).toBeNull();
    expect(await consistent(a.org.id)).toEqual([]);
  });

  it('2000 条流水：分页查询 1 秒内 / 2000 movements page quickly', async () => {
    await prisma.stockMovement.createMany({ data: Array.from({ length: 2000 }, (_, i) => ({ organizationId: a.org.id, productId: p.id, reason: 'ADJUSTMENT' as const, quantity: i % 2 ? -1 : 2, note: `n${i}` })) });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQuantity.toString()).toBe('1000');
    const t0 = Date.now();
    const res = await call(stockRoute.GET, { token: a.token, params: { id: p.id }, query: { page: '50', pageSize: '20' } });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.json.total).toBe(2000);
    expect(res.json.items).toHaveLength(20);
  });
});

describe('stock R2 demo', () => {
  it('演示数据：库存与流水一致、余额按时间连续、有低库存与缺货示例 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    expect(await consistent(org.id)).toEqual([]);
    const list = await prisma.product.findMany({ where: { organizationId: org.id }, include: { stockMovements: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    for (const prod of list) {
      let running = 0;
      for (const m of prod.stockMovements) {
        running += Number(m.quantity);
        expect(Number(m.balanceAfter), prod.sku).toBeCloseTo(running, 2);
        // 演示中库存不会为负 / demo stock never goes negative
        expect(Number(m.balanceAfter), prod.sku).toBeGreaterThanOrEqual(0);
      }
    }
    expect(list.some((x) => x.stockMovements.some((m) => m.reason === 'PURCHASE_RECEIPT'))).toBe(true);
    expect(list.some((x) => x.stockMovements.some((m) => m.reason === 'SALES_SHIPMENT'))).toBe(true);
    const admin = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'ADMIN' } });
    const s = await stockSummary({ organizationId: org.id, userId: admin.id, role: 'ADMIN' } as never);
    expect(s.low).toBeGreaterThanOrEqual(1);
    expect(s.out).toBeGreaterThanOrEqual(1);
  });
});
