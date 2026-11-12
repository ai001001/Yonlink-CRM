/**
 * 产品目录与商机产品明细 第一轮：功能测试。
 * Product catalog and deal line items round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as itemRoute from '@/app/api/deal-items/[id]/route';
import * as products from '@/app/api/products/route';
import * as productItem from '@/app/api/products/[id]/route';
import { prisma } from '@/server/db';
import { lineTotal } from '@/server/modules/deal-items';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let deal: { id: string };
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
  deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, amount: '999' } })).json;
});

const mkProduct = async (body: object) => (await call(products.POST, { token: a.token, body: { name: '产品', ...body } })).json;
const addItem = (body: object) => call(dealItems.POST, { token: a.token, params: { id: deal.id }, body });
const dealAmount = async () => (await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).amount.toString();

describe('products R1 catalog', () => {
  it('新增产品：SKU 转大写，默认单位/币种/启用 / create normalises SKU and applies defaults', async () => {
    const res = await call(products.POST, { token: a.token, body: { sku: ' dt-hd-11l ', name: '重卡增压器', unitPrice: '980' } });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ sku: 'DT-HD-11L', unit: '件', currency: 'CNY', isActive: true, unitPrice: '980' });
  });

  it('搜索（SKU/名称/分类）与启用筛选 / search and active filter', async () => {
    await mkProduct({ sku: 'A-1', name: '轴轮', category: '核心部件' });
    await mkProduct({ sku: 'B-2', name: '垫片', category: '配件', isActive: false });
    const q = async (query: Record<string, string>) => (await call(products.GET, { token: a.token, query })).json.items.map((p: { sku: string }) => p.sku);
    expect(await q({ q: '核心' })).toEqual(['A-1']);
    expect(await q({ q: 'b-2' })).toEqual(['B-2']);
    expect(await q({ active: 'true' })).toEqual(['A-1']);
    expect(await q({ active: 'false' })).toEqual(['B-2']);
  });

  it('修改、停用、删除未使用的产品 / update, deactivate and delete an unused product', async () => {
    const p = await mkProduct({ sku: 'X-1', unitPrice: '10' });
    const upd = await call(productItem.PATCH, { token: a.token, method: 'PATCH', params: { id: p.id }, body: { unitPrice: '12.5', isActive: false } });
    expect(upd.json).toMatchObject({ unitPrice: '12.5', isActive: false });
    expect((await call(productItem.DELETE, { token: a.token, method: 'DELETE', params: { id: p.id } })).status).toBe(204);
    expect(await prisma.product.count()).toBe(0);
    expect((await prisma.auditLog.findMany({ where: { entityType: 'product' }, orderBy: { createdAt: 'asc' } })).map((l) => l.action)).toEqual([
      'product.create',
      'product.update',
      'product.delete',
    ]);
  });
});

describe('products R1 deal line items', () => {
  it('小计计算精确（十进制，四舍五入到分）/ exact decimal line totals', () => {
    expect(lineTotal('3', '19.99', '0').toFixed(2)).toBe('59.97');
    expect(lineTotal('7', '0.10', '0').toFixed(2)).toBe('0.70');
    expect(lineTotal('3', '33.33', '10').toFixed(2)).toBe('89.99');
    expect(lineTotal('1', '0.05', '50').toFixed(2)).toBe('0.03');
    expect(lineTotal('2.5', '980', '8').toFixed(2)).toBe('2254.00');
    expect(lineTotal('9999999999', '9999999.99', '0').toFixed(2)).toBe('99999999890000000.01');
  });

  it('添加明细：默认取产品单价，保存产品名称与 SKU，商机金额 = 明细合计 / add uses the product price and sets the deal amount', async () => {
    const p = await mkProduct({ sku: 'HD-11', name: '重卡增压器', unitPrice: '980' });
    const res = await addItem({ productId: p.id, quantity: '3', discountPercent: '5' });
    expect(res.status).toBe(201);
    expect(res.json.item).toMatchObject({ productSku: 'HD-11', productName: '重卡增压器', unitPrice: '980', quantity: '3', discountPercent: '5', lineTotal: '2793' });
    expect(res.json.dealAmount).toBe('2793.00');
    expect(await dealAmount()).toBe('2793');
  });

  it('多条明细合计、修改与删除后金额随之更新 / totals follow add, update and remove', async () => {
    const p1 = await mkProduct({ sku: 'P1', unitPrice: '100' });
    const p2 = await mkProduct({ sku: 'P2', unitPrice: '0.10' });
    const i1 = (await addItem({ productId: p1.id, quantity: '2' })).json.item;
    await addItem({ productId: p2.id, quantity: '7', unitPrice: '0.10' });
    expect(await dealAmount()).toBe('200.7');
    const upd = await call(itemRoute.PATCH, { token: a.token, method: 'PATCH', params: { id: i1.id }, body: { quantity: '3', discountPercent: '10' } });
    expect(upd.json).toMatchObject({ dealAmount: '270.70', item: { lineTotal: '270' } });
    const del = await call(itemRoute.DELETE, { token: a.token, method: 'DELETE', params: { id: i1.id } });
    expect(del.json.dealAmount).toBe('0.70');
    const list = (await call(dealItems.GET, { token: a.token, params: { id: deal.id } })).json;
    expect(list).toMatchObject({ total: '0.70', currency: 'CNY' });
    expect(list.items).toHaveLength(1);
  });

  it('自定义单价；产品改名改价不影响已有明细 / custom price; later product changes do not affect items', async () => {
    const p = await mkProduct({ sku: 'P1', name: '旧名称', unitPrice: '100' });
    await addItem({ productId: p.id, quantity: '1', unitPrice: '88.8' });
    await call(productItem.PATCH, { token: a.token, method: 'PATCH', params: { id: p.id }, body: { name: '新名称', unitPrice: '200' } });
    const item = (await call(dealItems.GET, { token: a.token, params: { id: deal.id } })).json.items[0];
    expect(item).toMatchObject({ productName: '旧名称', unitPrice: '88.8', lineTotal: '88.8' });
  });

  it('明细操作写审计（含金额变化）/ item changes are audited with the amount change', async () => {
    const p = await mkProduct({ sku: 'P1', unitPrice: '10' });
    const i = (await addItem({ productId: p.id, quantity: '2' })).json.item;
    await call(itemRoute.PATCH, { token: a.token, method: 'PATCH', params: { id: i.id }, body: { quantity: '3' } });
    await call(itemRoute.DELETE, { token: a.token, method: 'DELETE', params: { id: i.id } });
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'deal', entityId: deal.id, action: { not: 'deal.create' } }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['deal.add_item', 'deal.update', 'deal.update_item', 'deal.update', 'deal.remove_item', 'deal.update']);
    expect(logs[1]!.changes).toEqual({ fields: { amount: ['999', '20'] }, via: 'deal.items' });
  });

  it('删除商机时明细一并删除，之后产品可删除 / items are removed with the deal; the product can then be deleted', async () => {
    const p = await mkProduct({ sku: 'P1', unitPrice: '10' });
    await addItem({ productId: p.id, quantity: '1' });
    await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: deal.id } });
    expect(await prisma.dealLineItem.count()).toBe(0);
    expect((await call(productItem.DELETE, { token: a.token, method: 'DELETE', params: { id: p.id } })).status).toBe(204);
  });

  it('演示数据：产品目录与明细，商机金额 = 明细合计 / demo catalog and items with consistent amounts', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const data = buildDemoData();
    expect(await prisma.product.count({ where: { organizationId: org.id } })).toBe(data.products.length);
    const dealsWithItems = await prisma.deal.findMany({ where: { organizationId: org.id, lineItems: { some: {} } }, include: { lineItems: true } });
    expect(dealsWithItems).toHaveLength(new Set(data.items.map((i) => i.deal)).size);
    for (const d of dealsWithItems) {
      const sum = d.lineItems.reduce((s, i) => s.plus(i.lineTotal), d.amount.minus(d.amount));
      expect(sum.equals(d.amount)).toBe(true);
      for (const i of d.lineItems) expect(i.lineTotal.equals(lineTotal(i.quantity, i.unitPrice, i.discountPercent))).toBe(true);
    }
  });
});
