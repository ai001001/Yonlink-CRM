/**
 * 多仓库 第一轮：功能测试（仓库：自动默认仓库、新建、代码校验与唯一、首个仓库自动为默认、切换默认、默认不能停用/取消/删除、
 * 有流水不能删除、权限、审计；按仓库调整与盘点；调拨；采购收货与销售发货到指定仓库、取消退回原仓库；流水查询的仓库库存与筛选）。
 * Multi-warehouse round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as productItem from '@/app/api/products/[id]/route';
import * as stock from '@/app/api/products/[id]/stock/route';
import * as transfer from '@/app/api/products/[id]/stock/transfer/route';
import * as products from '@/app/api/products/route';
import * as receive from '@/app/api/purchase-orders/[id]/receive/route';
import * as orderStatus from '@/app/api/sales-orders/[id]/status/route';
import * as warehouseItem from '@/app/api/warehouses/[id]/route';
import * as warehouses from '@/app/api/warehouses/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let sales: Awaited<ReturnType<typeof addUser>>;
let p: { id: string; sku: string };
const newWarehouse = (body: object, token = a.token) => call(warehouses.POST, { token, body: { code: 'w1', name: '仓库', ...body } });
const patchWarehouse = (id: string, body: object, token = a.token) => call(warehouseItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const adjust = (body: object, id = p.id) => call(stock.POST, { token: a.token, params: { id }, body: { mode: 'add', note: '调整', ...body } });
const moveStock = (body: object, id = p.id) => call(transfer.POST, { token: a.token, params: { id }, body: { note: '调拨', ...body } });
const ws = async (id = p.id) => Object.fromEntries((await prisma.productStock.findMany({ where: { productId: id }, include: { warehouse: true } })).map((s) => [s.warehouse.code, s.quantity.toString()]));
const total = async (id = p.id) => (await prisma.product.findUniqueOrThrow({ where: { id } })).stockQuantity.toString();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  sales = await addUser(a.org.id, 'SALES', '销售');
  p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品' } })).json;
});

describe('warehouses R1 maintenance', () => {
  it('自动默认仓库、新建、校验、切换默认、默认的限制、删除、权限、审计 / maintenance', async () => {
    // 第一次调整时自动建立默认仓库 MAIN / the first adjustment creates the default MAIN
    expect((await call(warehouses.GET, { token: a.token })).json.items).toEqual([]);
    await adjust({ quantity: '5' });
    const main = (await call(warehouses.GET, { token: sales.token })).json.items;
    expect(main).toMatchObject([{ code: 'MAIN', isDefault: true, isActive: true, products: 1, units: '5' }]);
    // 新建：代码转大写、唯一；非法代码；销售 403 / create
    const gz = await newWarehouse({ code: ' gz-1 ', name: '华南仓', address: '广州' });
    expect(gz.status).toBe(201);
    expect(gz.json).toMatchObject({ code: 'GZ-1', name: '华南仓', isDefault: false, isActive: true });
    expect((await newWarehouse({ code: 'GZ-1' })).json.error.details).toEqual({ code: ['taken'] });
    for (const code of ['', 'a b', 'x'.repeat(21), '仓库']) expect((await newWarehouse({ code })).status, code).toBe(400);
    expect((await newWarehouse({ code: 'S1' }, sales.token)).status).toBe(403);
    // 切换默认；默认不能取消、停用、删除 / switching the default and its limits
    expect((await patchWarehouse(gz.json.id, { isDefault: true })).json.isDefault).toBe(true);
    const list = (await call(warehouses.GET, { token: a.token })).json.items;
    expect(list.map((w: { code: string; isDefault: boolean }) => [w.code, w.isDefault])).toEqual([['GZ-1', true], ['MAIN', false]]);
    expect((await patchWarehouse(gz.json.id, { isDefault: false })).json.error.details).toEqual({ isDefault: ['need_default'] });
    expect((await patchWarehouse(gz.json.id, { isActive: false })).json.error.details).toEqual({ isActive: ['default_must_be_active'] });
    expect((await call(warehouseItem.DELETE, { token: a.token, params: { id: gz.json.id }, method: 'DELETE' })).json.error.details).toEqual({ isDefault: ['default'] });
    expect((await newWarehouse({ code: 'X', isDefault: true, isActive: false })).json.error.details).toEqual({ isActive: ['default_must_be_active'] });
    // 有流水的仓库不能删除，可以停用；空仓库可删除 / warehouses with movements cannot be deleted
    const mainId = main[0].id;
    expect((await call(warehouseItem.DELETE, { token: a.token, params: { id: mainId }, method: 'DELETE' })).json.error.details).toEqual({ id: ['has_movements'] });
    expect((await patchWarehouse(mainId, { isActive: false, name: '旧总仓' })).json).toMatchObject({ isActive: false, name: '旧总仓' });
    const empty = await newWarehouse({ code: 'EMPTY' });
    expect((await call(warehouseItem.DELETE, { token: a.token, params: { id: empty.json.id }, method: 'DELETE' })).status).toBe(204);
    // 其他组织 404 / other organizations
    const b = await createTenant('B');
    expect((await patchWarehouse(gz.json.id, { name: 'x' }, b.token)).status).toBe(404);
    expect((await call(warehouses.GET, { token: b.token })).json.items).toEqual([]);
    // 新组织的第一个仓库自动为默认 / an organization's first warehouse becomes the default
    expect((await newWarehouse({ code: 'B1' }, b.token)).json.isDefault).toBe(true);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'warehouse' } })).json.items.map((l: { action: string }) => l.action).sort();
    expect(logs).toEqual(['warehouse.create', 'warehouse.create', 'warehouse.delete', 'warehouse.update', 'warehouse.update']);
  });
});

describe('warehouses R1 stock', () => {
  it('按仓库调整与盘点；调拨；停用与未知仓库；流水查询 / adjustments, transfers, queries', async () => {
    await adjust({ quantity: '10' });
    const gz = (await newWarehouse({ code: 'GZ', name: '华南仓' })).json;
    expect((await adjust({ quantity: '5', warehouseId: gz.id })).json).toEqual({ quantity: '5', balanceAfter: '15', warehouseBalanceAfter: '5' });
    // 盘点按所选仓库：华南仓 5 → 8，差额 3 / counts use the chosen warehouse
    expect((await adjust({ mode: 'set', quantity: '8', warehouseId: gz.id })).json).toEqual({ quantity: '3', balanceAfter: '18', warehouseBalanceAfter: '8' });
    expect((await adjust({ mode: 'set', quantity: '8', warehouseId: gz.id })).json.error.details).toEqual({ quantity: ['no_change'] });
    expect(await ws()).toEqual({ MAIN: '10', GZ: '8' });
    // 调拨：总库存不变，成对流水共用调拨 ID / transfers keep the total and share a transfer id
    const main = await prisma.warehouse.findFirstOrThrow({ where: { organizationId: a.org.id, code: 'MAIN' } });
    const tr = await moveStock({ fromWarehouseId: main.id, toWarehouseId: gz.id, quantity: '4' });
    expect(tr.json).toMatchObject({ from: { code: 'MAIN', balance: '6' }, to: { code: 'GZ', balance: '12' }, total: '18' });
    expect(await ws()).toEqual({ MAIN: '6', GZ: '12' });
    expect(await total()).toBe('18');
    const pair = await prisma.stockMovement.findMany({ where: { transferId: tr.json.transferId }, orderBy: { quantity: 'asc' } });
    expect(pair.map((m) => [m.reason, m.quantity.toString(), m.warehouseId])).toEqual([['TRANSFER', '-4', main.id], ['TRANSFER', '4', gz.id]]);
    // 调出多于现有数量允许（与原库存规则一致，可为负）/ transferring more than on hand is allowed (negative, as before)
    expect((await moveStock({ fromWarehouseId: main.id, toWarehouseId: gz.id, quantity: '7' })).json.from.balance).toBe('-1');
    // 校验：同一仓库、数量 0、停用仓库、未知仓库、其他组织的仓库 / validation
    expect((await moveStock({ fromWarehouseId: gz.id, toWarehouseId: gz.id, quantity: '1' })).status).toBe(400);
    expect((await moveStock({ fromWarehouseId: main.id, toWarehouseId: gz.id, quantity: '0' })).status).toBe(400);
    const off = (await newWarehouse({ code: 'OFF', isActive: false })).json;
    expect((await adjust({ quantity: '1', warehouseId: off.id })).json.error.details).toEqual({ warehouseId: ['inactive'] });
    expect((await moveStock({ fromWarehouseId: main.id, toWarehouseId: off.id, quantity: '1' })).json.error.details).toEqual({ toWarehouseId: ['inactive'] });
    expect((await adjust({ quantity: '1', warehouseId: crypto.randomUUID() })).json.error.details).toEqual({ warehouseId: ['not_found'] });
    const b = await createTenant('B');
    const bw = (await newWarehouse({ code: 'B' }, b.token)).json;
    expect((await adjust({ quantity: '1', warehouseId: bw.id })).json.error.details).toEqual({ warehouseId: ['not_found'] });
    expect((await moveStock({ fromWarehouseId: main.id, toWarehouseId: gz.id, quantity: '1' }, p.id)).status).toBe(200);
    expect((await call(transfer.POST, { token: sales.token, params: { id: p.id }, body: { fromWarehouseId: main.id, toWarehouseId: gz.id, quantity: '1', note: 'x' } })).status).toBe(403);
    // 流水查询：各仓库库存（默认在前，停用且为 0 的不显示）、按仓库筛选、流水带仓库与仓库余额 / movement query
    const q = (await call(stock.GET, { token: sales.token, params: { id: p.id } })).json;
    expect(q.warehouses.map((x: { warehouse: { code: string }; quantity: string }) => [x.warehouse.code, x.quantity])).toEqual([['MAIN', '-2'], ['GZ', '20']]);
    expect(q.items[0]).toMatchObject({ reason: 'TRANSFER', warehouse: { code: expect.any(String) }, warehouseBalanceAfter: expect.any(String) });
    const onlyGz = (await call(stock.GET, { token: a.token, params: { id: p.id }, query: { warehouseId: gz.id } })).json.items;
    expect(onlyGz.every((m: { warehouse: { code: string } }) => m.warehouse.code === 'GZ')).toBe(true);
    // 审计：调整含仓库，调拨含两端 / audits
    const tlog = (await call(auditLogs.GET, { token: a.token, query: { action: 'product.stock_transfer' } })).json.items.at(-1);
    expect(tlog.changes).toMatchObject({ sku: 'P-1', from: 'MAIN', to: 'GZ', quantity: '4', fromStock: '6', toStock: '12' });
  });

  it('采购收货与销售发货到指定仓库；取消退回原仓库（即使已停用）；发货以外不能指定仓库 / receipts and shipments', async () => {
    const gz = (await newWarehouse({ code: 'GZ', name: '华南仓' })).json; // 第一个仓库即默认 / first warehouse is the default
    const tj = (await newWarehouse({ code: 'TJ', name: '华北仓' })).json;
    const vendor = await prisma.vendor.create({ data: { organizationId: a.org.id, name: '供应商' } });
    const po = await prisma.purchaseOrder.create({ data: { organizationId: a.org.id, vendorId: vendor.id, poNumber: 'PO-1', subject: '采购', currency: 'CNY', status: 'ORDERED', orderedAt: new Date() } });
    const line = await prisma.purchaseOrderLineItem.create({ data: { organizationId: a.org.id, purchaseOrderId: po.id, position: 1, productSku: 'P-1', productName: '产品', unit: '件', quantity: '10', unitCost: '1', lineTotal: '10' } });
    // 停用仓库收货被拒绝且不改变收货数量 / an inactive warehouse refuses the receipt and nothing changes
    const off = (await newWarehouse({ code: 'OFF', isActive: false })).json;
    expect((await call(receive.POST, { token: a.token, params: { id: po.id }, body: { lines: [{ lineId: line.id, quantity: '4' }], warehouseId: off.id } })).status).toBe(409);
    expect((await prisma.purchaseOrderLineItem.findUniqueOrThrow({ where: { id: line.id } })).receivedQuantity.toString()).toBe('0');
    expect((await call(receive.POST, { token: a.token, params: { id: po.id }, body: { lines: [{ lineId: line.id, quantity: '4' }], warehouseId: tj.id } })).status).toBe(200);
    expect((await call(receive.POST, { token: a.token, params: { id: po.id }, body: { lines: [{ lineId: line.id, quantity: '6' }] } })).status).toBe(200);
    expect(await ws()).toEqual({ TJ: '4', GZ: '6' });
    // 销售发货从华北仓；取消时退回华北仓（已停用也退回）/ ship from TJ; cancel returns to TJ even when deactivated
    const acc = await prisma.account.create({ data: { organizationId: a.org.id, name: '客户' } });
    const deal = await prisma.deal.create({ data: { organizationId: a.org.id, accountId: acc.id, name: '商机' } });
    const money = { currency: 'CNY', subtotal: '3', taxAmount: '0', total: '3' };
    const quote = await prisma.quote.create({ data: { organizationId: a.org.id, dealId: deal.id, quoteNumber: 'Q-1', subject: '报价', status: 'ACCEPTED', ...money } });
    const order = await prisma.salesOrder.create({ data: { organizationId: a.org.id, quoteId: quote.id, dealId: deal.id, orderNumber: 'SO-1', subject: '订单', taxPercent: '0', ...money } });
    await prisma.salesOrderLineItem.create({ data: { organizationId: a.org.id, salesOrderId: order.id, position: 1, productSku: 'P-1', productName: '产品', unit: '件', quantity: '3', unitPrice: '1', lineTotal: '3' } });
    expect((await call(orderStatus.POST, { token: a.token, params: { id: order.id }, body: { status: 'CANCELLED', warehouseId: tj.id } })).status).toBe(400);
    expect((await call(orderStatus.POST, { token: a.token, params: { id: order.id }, body: { status: 'SHIPPED', warehouseId: tj.id } })).status).toBe(200);
    expect(await ws()).toEqual({ TJ: '1', GZ: '6' });
    await patchWarehouse(tj.id, { isActive: false });
    expect((await call(orderStatus.POST, { token: a.token, params: { id: order.id }, body: { status: 'CANCELLED' } })).status).toBe(200);
    expect(await ws()).toEqual({ TJ: '4', GZ: '6' });
    expect(await total()).toBe('10');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.status', entityId: order.id }, orderBy: { createdAt: 'desc' } });
    expect((log.changes as { stock: object[] }).stock).toEqual([{ sku: 'P-1', quantity: '3', balance: '10', warehouse: 'TJ' }]);
    void gz;
    // 删除产品（无流水的产品）时各仓库库存随之删除 / deleting a product without history removes its warehouse rows
    const q2 = (await call(products.POST, { token: a.token, body: { sku: 'P-2', name: '无流水' } })).json;
    expect((await call(productItem.DELETE, { token: a.token, params: { id: q2.id }, method: 'DELETE' })).status).toBe(204);
  });
});
