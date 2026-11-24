/**
 * 多仓库 第二轮：集成测试（同一产品并发调整与调拨后各仓库与总库存一致、仓库余额连续；新组织并发首次流水只建一个默认仓库；
 * 并发切换默认只有一个默认；数据库约束与守卫；1000 条随机流水后的一致性；演示数据的仓库、调拨与一致性）。
 * Multi-warehouse round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_TRANSFERS, DEMO_WAREHOUSES } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as stock from '@/app/api/products/[id]/stock/route';
import * as transfer from '@/app/api/products/[id]/stock/transfer/route';
import * as products from '@/app/api/products/route';
import * as warehouseItem from '@/app/api/warehouses/[id]/route';
import * as warehouses from '@/app/api/warehouses/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;

/** 各仓库库存之和等于总库存；每个仓库的流水累计等于该仓库库存，余额连续 / per-warehouse sums and running balances */
async function consistency(org: string) {
  const problems: string[] = [];
  for (const p of await prisma.product.findMany({ where: { organizationId: org } })) {
    const stocks = await prisma.productStock.findMany({ where: { productId: p.id } });
    const sum = stocks.reduce((s, x) => s + Number(x.quantity), 0);
    if (Math.abs(sum - Number(p.stockQuantity)) > 0.001) problems.push(`${p.sku}: total ${p.stockQuantity} vs ${sum}`);
    for (const s of stocks) {
      const moves = await prisma.stockMovement.findMany({ where: { productId: p.id, warehouseId: s.warehouseId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      let run = 0;
      for (const m of moves) run += Number(m.quantity);
      if (Math.abs(run - Number(s.quantity)) > 0.001) problems.push(`${p.sku}@${s.warehouseId}: ${s.quantity} vs movements ${run}`);
    }
  }
  return problems;
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('warehouses R2', () => {
  it('并发调整与调拨后一致；仓库余额序列连续 / concurrent adjustments and transfers stay consistent', async () => {
    const p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品' } })).json;
    const w = [];
    for (const code of ['A1', 'B1', 'C1']) w.push((await call(warehouses.POST, { token: a.token, body: { code, name: code } })).json.id as string);
    const jobs = [];
    for (let i = 0; i < 30; i++) {
      jobs.push(call(stock.POST, { token: a.token, params: { id: p.id }, body: { mode: 'add', quantity: String((i % 5) + 1), note: 'n', warehouseId: w[i % 3] } }));
      jobs.push(call(transfer.POST, { token: a.token, params: { id: p.id }, body: { fromWarehouseId: w[i % 3], toWarehouseId: w[(i + 1) % 3], quantity: '1', note: 't' } }));
    }
    const res = await Promise.all(jobs);
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await consistency(a.org.id)).toEqual([]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQuantity.toString()).toBe('90');
    // 每个仓库的余额按写入顺序连续（流水按产品行锁依次写入）/ per-warehouse balances follow the write order
    for (const id of w) {
      const moves = await prisma.$queryRaw<{ quantity: string; warehouse_balance_after: string }[]>`SELECT quantity::text, warehouse_balance_after::text FROM stock_movements WHERE warehouse_id = ${id}::uuid ORDER BY created_at, id`;
      let run = 0;
      const balances = moves.map((m) => (run += Number(m.quantity)));
      expect(new Set(moves.map((m) => Number(m.warehouse_balance_after)))).toEqual(new Set(balances));
    }
  });

  it('新组织并发首次流水只建一个默认仓库；并发切换默认只有一个默认 / default warehouse races', async () => {
    const p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品' } })).json;
    const q = (await call(products.POST, { token: a.token, body: { sku: 'P-2', name: '产品2' } })).json;
    const res = await Promise.all([p, q, p, q].map((x) => call(stock.POST, { token: a.token, params: { id: x.id }, body: { mode: 'add', quantity: '1', note: 'n' } })));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await prisma.warehouse.findMany({ where: { organizationId: a.org.id } })).toMatchObject([{ code: 'MAIN', isDefault: true }]);
    const x = (await call(warehouses.POST, { token: a.token, body: { code: 'X', name: 'X' } })).json;
    const y = (await call(warehouses.POST, { token: a.token, body: { code: 'Y', name: 'Y' } })).json;
    await Promise.all([x, y].map((wh) => call(warehouseItem.PATCH, { token: a.token, params: { id: wh.id }, body: { isDefault: true }, method: 'PATCH' })));
    expect(await prisma.warehouse.count({ where: { organizationId: a.org.id, isDefault: true } })).toBe(1);
  });

  it('数据库约束与守卫；1000 条随机流水后一致 / constraints, guards and scale', async () => {
    const p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品' } })).json;
    await call(stock.POST, { token: a.token, params: { id: p.id }, body: { mode: 'add', quantity: '5', note: 'n' } });
    const main = await prisma.warehouse.findFirstOrThrow({ where: { organizationId: a.org.id } });
    const m = await prisma.stockMovement.findFirstOrThrow({ where: { productId: p.id } });
    await expect(prisma.$executeRaw`UPDATE product_stocks SET quantity = 99 WHERE product_id = ${p.id}::uuid`).rejects.toThrow(/warehouse stock changes only through stock movements/);
    const other = await prisma.warehouse.create({ data: { organizationId: a.org.id, code: 'O', name: 'O' } });
    await expect(prisma.$executeRaw`INSERT INTO product_stocks (organization_id, product_id, warehouse_id, quantity) VALUES (${a.org.id}::uuid, ${p.id}::uuid, ${other.id}::uuid, 3)`).rejects.toThrow(/warehouse stock changes only through stock movements/);
    await expect(prisma.$executeRaw`UPDATE stock_movements SET warehouse_id = ${other.id}::uuid WHERE id = ${m.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE warehouses SET code = 'lower' WHERE id = ${other.id}::uuid`).rejects.toThrow(/warehouses_check/);
    await expect(prisma.$executeRaw`UPDATE warehouses SET is_active = false WHERE id = ${main.id}::uuid`).rejects.toThrow(/warehouses_check/);
    await expect(prisma.$executeRaw`UPDATE warehouses SET is_default = true WHERE id = ${other.id}::uuid`).rejects.toThrow(/warehouses_one_default/);
    await expect(prisma.stockMovement.create({ data: { organizationId: a.org.id, productId: p.id, warehouseId: main.id, reason: 'TRANSFER', quantity: 1 } })).rejects.toThrow(/stock_movements_transfer_check/);
    await expect(prisma.stockMovement.create({ data: { organizationId: a.org.id, productId: p.id, warehouseId: main.id, reason: 'ADJUSTMENT', quantity: 1, transferId: crypto.randomUUID() } })).rejects.toThrow(/stock_movements_transfer_check/);
    const b = await createTenant('B');
    const bw = await prisma.warehouse.create({ data: { organizationId: b.org.id, code: 'B', name: 'B', isDefault: true } });
    await expect(prisma.stockMovement.create({ data: { organizationId: a.org.id, productId: p.id, warehouseId: bw.id, reason: 'ADJUSTMENT', quantity: 1 } })).rejects.toThrow();
    await expect(prisma.warehouse.delete({ where: { id: main.id } })).rejects.toThrow();
    // 1000 条随机流水 / 1000 random movements
    const ws = [main.id, other.id];
    await prisma.stockMovement.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ organizationId: a.org.id, productId: p.id, warehouseId: ws[i % 2]!, reason: 'ADJUSTMENT' as const, quantity: ((i * 7) % 11) - 5 || 1, note: `n${i}` })) });
    expect(await consistency(a.org.id)).toEqual([]);
  }, 120_000);

  it('演示数据：3 个仓库、默认总仓、调拨成对、库存一致 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.warehouse.findMany({ where: { organizationId: org.id }, orderBy: { code: 'asc' } });
    expect(rows.map((w) => [w.code, w.isDefault])).toEqual([...DEMO_WAREHOUSES].map((w) => [w.code, w.isDefault]).sort());
    const transfers = await prisma.stockMovement.groupBy({ by: ['transferId'], where: { organizationId: org.id, reason: 'TRANSFER' }, _sum: { quantity: true }, _count: { _all: true } });
    expect(transfers).toHaveLength(DEMO_TRANSFERS.length);
    expect(transfers.every((t) => t._count._all === 2 && Number(t._sum.quantity) === 0)).toBe(true);
    expect(await consistency(org.id)).toEqual([]);
    const regional = await prisma.productStock.findMany({ where: { organizationId: org.id, warehouse: { code: { in: ['GZ', 'TJ'] } } } });
    expect(regional.map((s) => Number(s.quantity)).sort((x, y) => x - y)).toEqual(DEMO_TRANSFERS.map((t) => t.quantity).sort((x, y) => x - y));
  });
});
