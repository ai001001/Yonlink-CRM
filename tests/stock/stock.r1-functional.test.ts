/**
 * 产品库存 第一轮：功能测试（新产品库存 0；再订货水平校验；手工调整：增减、盘点、无变化 409、原因必填、权限、审计；
 * 采购收货增加（部分收货、手工明细无对应产品跳过）；销售订单发货减少（允许为负）、送达不变、已发货取消退回、未发货取消不变；
 * 流水与采购单号可见性；低库存与缺货筛选与汇总；有流水的产品不能删除；不能直接修改库存）。
 * Product stock round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as stockRoute from '@/app/api/products/[id]/stock/route';
import * as productItem from '@/app/api/products/[id]/route';
import * as products from '@/app/api/products/route';
import * as summary from '@/app/api/products/stock-summary/route';
import * as poReceive from '@/app/api/purchase-orders/[id]/receive/route';
import * as poStatus from '@/app/api/purchase-orders/[id]/status/route';
import * as pos from '@/app/api/purchase-orders/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as orderStatus from '@/app/api/sales-orders/[id]/status/route';
import * as orders from '@/app/api/sales-orders/route';
import * as vendors from '@/app/api/vendors/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let p1: { id: string };
let p2: { id: string };

const adjust = (id: string, body: object, token = a.token) => call(stockRoute.POST, { token, params: { id }, body });
const stockOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).stockQuantity.toString();
const movements = (id: string, token = a.token) => call(stockRoute.GET, { token, params: { id } });

/** 采购单：p1 × 10、手工件 × 5，下单 / a PO with p1 × 10 and a manual line × 5, ordered */
async function orderedPo() {
  const vendor = (await call(vendors.POST, { token: a.token, body: { name: `供应商${Math.random()}` } })).json;
  const po = (await call(pos.POST, { token: a.token, body: { vendorId: vendor.id, subject: '补货', lines: [{ productId: p1.id, quantity: '10', unitCost: '100' }, { productSku: 'M-1', productName: '手工件', unit: '个', quantity: '5', unitCost: '1' }] } })).json;
  expect((await call(poStatus.POST, { token: a.token, params: { id: po.id }, body: { status: 'ORDERED' } })).status).toBe(200);
  return (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { position: 'asc' } } } }));
}

/** 销售订单：商机明细 p1 × 3、p2 × 2 → 报价 → 接受 → 订单 / a sales order with p1 × 3 and p2 × 2 */
async function salesOrder() {
  const acc = (await call(accounts.POST, { token: a.token, body: { name: `客户${Math.random()}`, address: '上海' } })).json;
  const deal = (await call(deals.POST, { token: a.token, body: { name: '订单商机', accountId: acc.id } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: p1.id, quantity: '3' } });
  await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: p2.id, quantity: '2' } });
  const q = (await call(quotes.POST, { token: a.token, body: { dealId: deal.id } })).json;
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  const order = await call(orders.POST, { token: a.token, body: { quoteId: q.id } });
  expect(order.status).toBe(201);
  return order.json as { id: string; orderNumber: string };
}
const setStatus = (id: string, status: string, extra: object = {}) => call(orderStatus.POST, { token: a.token, params: { id }, body: { status, ...extra } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  p1 = (await call(products.POST, { token: a.token, body: { sku: 'p-1', name: '增压器', unitPrice: '1000', reorderLevel: '5' } })).json;
  p2 = (await call(products.POST, { token: a.token, body: { sku: 'P-2', name: '垫片', unitPrice: '10' } })).json;
});

describe('stock R1 adjustments', () => {
  it('新产品库存 0；再订货水平校验；增减、盘点、无变化、原因、权限、审计 / adjustments', async () => {
    expect(await stockOf(p1.id)).toBe('0');
    expect((await call(products.POST, { token: a.token, body: { sku: 'X', name: 'x', reorderLevel: '-1' } })).status).toBe(400);
    expect((await call(products.POST, { token: a.token, body: { sku: 'X', name: 'x', stockQuantity: '9' } })).status).toBe(400);
    expect((await call(productItem.PATCH, { token: a.token, params: { id: p1.id }, body: { stockQuantity: '9' }, method: 'PATCH' })).status).toBe(400);
    expect((await call(productItem.PATCH, { token: a.token, params: { id: p1.id }, body: { reorderLevel: '8.5' }, method: 'PATCH' })).json.reorderLevel).toBe('8.5');

    // 多仓库（#60b）起返回值增加该仓库的余额（只有默认仓库时与总数相同）/ since #60b the warehouse balance is returned too
    expect((await adjust(p1.id, { mode: 'add', quantity: '20', note: '期初' })).json).toEqual({ quantity: '20', balanceAfter: '20', warehouseBalanceAfter: '20' });
    expect((await adjust(p1.id, { mode: 'add', quantity: '-2.5', note: '损耗' })).json).toEqual({ quantity: '-2.5', balanceAfter: '17.5', warehouseBalanceAfter: '17.5' });
    expect((await adjust(p1.id, { mode: 'set', quantity: '15', note: '盘点' })).json).toEqual({ quantity: '-2.5', balanceAfter: '15', warehouseBalanceAfter: '15' });
    expect((await adjust(p1.id, { mode: 'set', quantity: '15', note: '盘点' })).json.error.details).toEqual({ quantity: ['no_change'] });
    for (const body of [{ mode: 'add', quantity: '0', note: 'x' }, { mode: 'add', quantity: '1', note: ' ' }, { mode: 'set', quantity: '-1', note: 'x' }, { mode: 'add', quantity: '1.234', note: 'x' }, { mode: 'move', quantity: '1', note: 'x' }, { mode: 'add', quantity: '1' }]) {
      expect((await adjust(p1.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await adjust(p1.id, { mode: 'add', quantity: '1', note: 'x' }, rep.token)).status).toBe(403);
    const b = await createTenant('B');
    expect((await adjust(p1.id, { mode: 'add', quantity: '1', note: 'x' }, b.token)).status).toBe(404);
    expect(await stockOf(p1.id)).toBe('15');
    const logs = await prisma.auditLog.findMany({ where: { action: 'product.stock_adjust' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.changes)).toEqual([
      // 多仓库（#60b）起审计含仓库代码与该仓库的前后库存 / since #60b the audit carries the warehouse and its stock
      { sku: 'P-1', mode: 'add', warehouse: 'MAIN', quantity: '20', warehouseStock: ['0', '20'], stock: ['0', '20'] },
      { sku: 'P-1', mode: 'add', warehouse: 'MAIN', quantity: '-2.5', warehouseStock: ['20', '17.5'], stock: ['20', '17.5'] },
      { sku: 'P-1', mode: 'set', warehouse: 'MAIN', quantity: '-2.5', warehouseStock: ['17.5', '15'], stock: ['17.5', '15'] },
    ]);
    // 流水：最新在前、原因与操作人；销售可查看 / movements newest first; reps may view
    const m = (await movements(p1.id, rep.token)).json;
    expect(m.product).toMatchObject({ sku: 'P-1', stockQuantity: '15', reorderLevel: '8.5' });
    expect(m.items.map((x: { reason: string; quantity: string; balanceAfter: string; note: string; actor: { id: string } }) => [x.reason, x.quantity, x.balanceAfter, x.note, x.actor.id])).toEqual([
      ['ADJUSTMENT', '-2.5', '15', '盘点', a.user.id],
      ['ADJUSTMENT', '-2.5', '17.5', '损耗', a.user.id],
      ['ADJUSTMENT', '20', '20', '期初', a.user.id],
    ]);
  });
});

describe('stock R1 documents', () => {
  it('采购收货增加库存（部分收货、手工明细跳过）；采购单号按权限显示 / purchase receipts', async () => {
    const po = await orderedPo();
    const [l1, l2] = po.lines;
    expect((await call(poReceive.POST, { token: a.token, params: { id: po.id }, body: { lines: [{ lineId: l1!.id, quantity: '4' }, { lineId: l2!.id, quantity: '5' }] } })).status).toBe(200);
    expect(await stockOf(p1.id)).toBe('4');
    expect((await call(poReceive.POST, { token: a.token, params: { id: po.id }, body: { lines: [{ lineId: l1!.id, quantity: '6' }] } })).status).toBe(200);
    expect(await stockOf(p1.id)).toBe('10');
    expect(await prisma.stockMovement.count()).toBe(2);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'purchase.receive' }, orderBy: { createdAt: 'desc' } });
    expect(log.changes).toMatchObject({ stock: [{ sku: 'P-1', quantity: '6', balance: '10' }] });
    // 采购单号：管理员可见，销售（无 purchase.read）不可见 / PO numbers for admins, hidden from reps
    expect((await movements(p1.id)).json.items[0].purchaseOrder).toEqual({ id: po.id, poNumber: po.poNumber });
    expect((await movements(p1.id, rep.token)).json.items[0]).toMatchObject({ reason: 'PURCHASE_RECEIPT', purchaseOrder: null });
  });

  it('销售订单：发货减少（允许负数）、送达不变、已发货取消退回、未发货取消不变 / sales orders', async () => {
    await adjust(p1.id, { mode: 'add', quantity: '2', note: '期初' });
    const o1 = await salesOrder();
    expect((await setStatus(o1.id, 'SHIPPED')).status).toBe(200);
    expect([await stockOf(p1.id), await stockOf(p2.id)]).toEqual(['-1', '-2']);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.status', entityId: o1.id } })).changes).toMatchObject({ stock: [{ sku: 'P-1', quantity: '-3', balance: '-1' }, { sku: 'P-2', quantity: '-2', balance: '-2' }] });
    expect((await setStatus(o1.id, 'DELIVERED')).status).toBe(200);
    expect(await stockOf(p1.id)).toBe('-1');

    const o2 = await salesOrder();
    await setStatus(o2.id, 'SHIPPED');
    expect(await stockOf(p1.id)).toBe('-4');
    expect((await setStatus(o2.id, 'CANCELLED', { reason: '客户取消' })).status).toBe(200);
    expect([await stockOf(p1.id), await stockOf(p2.id)]).toEqual(['-1', '-2']);
    const reasons = (await prisma.stockMovement.findMany({ where: { salesOrderId: o2.id }, orderBy: { createdAt: 'asc' } })).map((m) => [m.reason, m.quantity.toString()]);
    expect(reasons).toEqual([
      ['SALES_SHIPMENT', '-3'],
      ['SALES_SHIPMENT', '-2'],
      ['SALES_RETURN', '3'],
      ['SALES_RETURN', '2'],
    ]);
    const o3 = await salesOrder();
    await setStatus(o3.id, 'CANCELLED');
    expect(await prisma.stockMovement.count({ where: { salesOrderId: o3.id } })).toBe(0);
    // 流水显示订单号 / movements show the order number
    expect((await movements(p1.id, rep.token)).json.items[0]).toMatchObject({ reason: 'SALES_RETURN', salesOrder: { id: o2.id, orderNumber: o2.orderNumber } });
  });
});

describe('stock R1 filters and guards', () => {
  it('低库存与缺货筛选、汇总；有流水不能删除；不能直接修改库存 / filters and guards', async () => {
    const p3 = (await call(products.POST, { token: a.token, body: { sku: 'P-3', name: '螺栓', reorderLevel: '10' } })).json;
    await adjust(p1.id, { mode: 'add', quantity: '5', note: 'x' }); // 5 ≤ 5 → 低库存 / low
    await adjust(p3.id, { mode: 'add', quantity: '50', note: 'x' }); // 正常 / normal
    // p2 为 0 且无再订货水平 → 缺货不低库存 / p2 at 0 without a reorder level → out, not low
    const list = async (stock: string) => (await call(products.GET, { token: a.token, query: { stock } })).json.items.map((x: { sku: string }) => x.sku);
    expect(await list('low')).toEqual(['P-1']);
    expect(await list('out')).toEqual(['P-2']);
    expect((await call(summary.GET, { token: rep.token })).json).toEqual({ low: 1, out: 1 });
    // 停用产品不计入汇总 / inactive products are not counted
    await call(productItem.PATCH, { token: a.token, params: { id: p2.id }, body: { isActive: false }, method: 'PATCH' });
    expect((await call(summary.GET, { token: a.token })).json).toEqual({ low: 1, out: 0 });
    expect((await call(products.GET, { token: a.token, query: { stock: 'none' } })).status).toBe(400);
    // 有流水的产品不能删除；没有的可以 / products with movements cannot be deleted
    expect((await call(productItem.DELETE, { token: a.token, params: { id: p1.id }, method: 'DELETE' })).json.error.details).toEqual({ product: ['has_stock'] });
    expect((await call(productItem.DELETE, { token: a.token, params: { id: p2.id }, method: 'DELETE' })).status).toBe(204);
    await expect(prisma.$executeRaw`UPDATE products SET stock_quantity = 999 WHERE id = ${p1.id}::uuid`).rejects.toThrow(/stock quantity changes only through stock movements/);
  });
});
