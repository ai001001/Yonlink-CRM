/**
 * 产品目录与商机产品明细 第二轮：集成测试（角色权限、金额与币种锁定、币种不一致、停用产品、
 * 使用中的产品不能删除、SKU 唯一、组织隔离、异常输入、数据库约束）。
 * Product catalog and deal line items round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as itemRoute from '@/app/api/deal-items/[id]/route';
import * as products from '@/app/api/products/route';
import * as productItem from '@/app/api/products/[id]/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let product: { id: string };
let salesDeal: { id: string };
beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  product = (await call(products.POST, { token: admin.token, body: { sku: 'P-1', name: '产品', unitPrice: '100' } })).json;
  const acc = (await call(accounts.POST, { token: sales1.token, body: { name: '销售1客户' } })).json;
  salesDeal = (await call(deals.POST, { token: sales1.token, body: { name: '销售1商机', accountId: acc.id } })).json;
});

const add = (who: Who, dealId: string, body: object) => call(dealItems.POST, { token: who.token, params: { id: dealId }, body });

describe('products R2 permissions', () => {
  it('只有管理员与经理能维护产品；所有角色可查看 / only admins and managers maintain products', async () => {
    expect((await call(products.POST, { token: manager.token, body: { sku: 'M-1', name: 'x' } })).status).toBe(201);
    for (const who of [sales1, viewer]) {
      expect((await call(products.POST, { token: who.token, body: { sku: 'S-1', name: 'x' } })).status).toBe(403);
      expect((await call(productItem.PATCH, { token: who.token, method: 'PATCH', params: { id: product.id }, body: { unitPrice: '1' } })).status).toBe(403);
      expect((await call(productItem.DELETE, { token: who.token, method: 'DELETE', params: { id: product.id } })).status).toBe(403);
      expect((await call(products.GET, { token: who.token })).json.total).toBe(2);
    }
  });

  it('明细：销售代表只能改自己的商机，只读不能改，经理可改 / line items follow deal edit rights', async () => {
    expect((await add(sales1, salesDeal.id, { productId: product.id, quantity: '1' })).status).toBe(201);
    expect((await add(sales2, salesDeal.id, { productId: product.id, quantity: '1' })).status).toBe(404);
    expect((await add(viewer, salesDeal.id, { productId: product.id, quantity: '1' })).status).toBe(403);
    expect((await add(manager, salesDeal.id, { productId: product.id, quantity: '1' })).status).toBe(201);
    const item = (await call(dealItems.GET, { token: sales1.token, params: { id: salesDeal.id } })).json.items[0];
    expect((await call(itemRoute.PATCH, { token: sales2.token, method: 'PATCH', params: { id: item.id }, body: { quantity: '9' } })).status).toBe(404);
    expect((await call(itemRoute.DELETE, { token: viewer.token, method: 'DELETE', params: { id: item.id } })).status).toBe(403);
    expect((await call(dealItems.GET, { token: viewer.token, params: { id: salesDeal.id } })).json.items).toHaveLength(2);
  });
});

describe('products R2 business rules', () => {
  it('有明细时不能手工改金额或币种；金额不变的保存允许；明细清空后恢复手工 / amount and currency lock', async () => {
    const item = (await add(admin, salesDeal.id, { productId: product.id, quantity: '2' })).json.item;
    const patch = (body: object) => call(dealItem.PATCH, { token: admin.token, method: 'PATCH', params: { id: salesDeal.id }, body });
    const amountRes = await patch({ amount: '1' });
    expect(amountRes.status).toBe(409);
    expect(amountRes.json.error.details.amount).toEqual(['calculated_from_items']);
    expect((await patch({ currency: 'USD' })).json.error.details.currency).toEqual(['locked_by_items']);
    expect((await patch({ amount: '200.00', currency: 'CNY', name: '改名可以' })).status).toBe(200);
    await call(itemRoute.DELETE, { token: admin.token, method: 'DELETE', params: { id: item.id } });
    expect((await patch({ amount: '5', currency: 'USD' })).status).toBe(200);
  });

  it('币种不一致与停用产品不能添加 / currency mismatch and inactive products are rejected', async () => {
    const usd = (await call(products.POST, { token: admin.token, body: { sku: 'U-1', name: 'x', currency: 'USD', unitPrice: '1' } })).json;
    expect((await add(admin, salesDeal.id, { productId: usd.id, quantity: '1' })).json.error.details.productId).toEqual(['currency_mismatch']);
    await call(productItem.PATCH, { token: admin.token, method: 'PATCH', params: { id: product.id }, body: { isActive: false } });
    expect((await add(admin, salesDeal.id, { productId: product.id, quantity: '1' })).json.error.details.productId).toEqual(['inactive']);
    expect(await prisma.dealLineItem.count()).toBe(0);
  });

  it('停用产品不影响已有明细，明细仍可修改 / deactivation keeps existing items editable', async () => {
    const item = (await add(admin, salesDeal.id, { productId: product.id, quantity: '1' })).json.item;
    await call(productItem.PATCH, { token: admin.token, method: 'PATCH', params: { id: product.id }, body: { isActive: false } });
    expect((await call(itemRoute.PATCH, { token: admin.token, method: 'PATCH', params: { id: item.id }, body: { quantity: '4' } })).json.dealAmount).toBe('400.00');
  });

  it('使用中的产品不能删除（409），数据库 RESTRICT 兜底 / products in use cannot be deleted', async () => {
    await add(admin, salesDeal.id, { productId: product.id, quantity: '1' });
    const res = await call(productItem.DELETE, { token: admin.token, method: 'DELETE', params: { id: product.id } });
    expect(res.status).toBe(409);
    expect(res.json.error.details.product).toEqual(['in_use']);
    await expect(prisma.product.delete({ where: { id: product.id } })).rejects.toThrow();
  });

  it('SKU 组织内唯一且不区分大小写（409）；其他组织可用同一 SKU / SKU uniqueness', async () => {
    expect((await call(products.POST, { token: admin.token, body: { sku: 'p-1', name: 'dup' } })).status).toBe(409);
    const other = await createTenant('B', 'ADMIN');
    expect((await call(products.POST, { token: other.token, body: { sku: 'P-1', name: 'ok' } })).status).toBe(201);
  });

  it('批量改阶段不影响由明细计算的金额 / bulk stage changes keep computed amounts', async () => {
    await add(admin, salesDeal.id, { productId: product.id, quantity: '3' });
    await call(dealBulk.POST, { token: admin.token, body: { action: 'stage', ids: [salesDeal.id], stage: 'PROPOSAL' } });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: salesDeal.id } })).amount.toString()).toBe('300');
  });
});

describe('products R2 isolation & input', () => {
  it('其他组织的产品不能用于本组织商机；明细与产品跨组织 404 / cross-org isolation', async () => {
    const other = await createTenant('B', 'ADMIN');
    const otherProduct = (await call(products.POST, { token: other.token, body: { sku: 'B-1', name: 'x', unitPrice: '1' } })).json;
    expect((await add(admin, salesDeal.id, { productId: otherProduct.id, quantity: '1' })).json.error.details.productId).toEqual(['not_found']);
    expect((await call(productItem.GET, { token: admin.token, params: { id: otherProduct.id } })).status).toBe(404);
    const item = (await add(admin, salesDeal.id, { productId: product.id, quantity: '1' })).json.item;
    expect((await call(itemRoute.DELETE, { token: other.token, method: 'DELETE', params: { id: item.id } })).status).toBe(404);
    expect((await call(dealItems.GET, { token: other.token, params: { id: salesDeal.id } })).status).toBe(404);
  });

  it.each([
    [{ quantity: '0' }],
    [{ quantity: '-1' }],
    [{ quantity: '1.234' }],
    [{ quantity: 'abc' }],
    [{ quantity: '1', discountPercent: '100.01' }],
    [{ quantity: '1', discountPercent: '-5' }],
    [{ quantity: '1', unitPrice: '-1' }],
    [{ quantity: '1', lineTotal: '1' }],
    [{}],
  ])('非法明细 %j → 400 / invalid line items', async (body) => {
    expect((await add(admin, salesDeal.id, { productId: product.id, ...body })).status).toBe(400);
  });

  it('折扣 100% 小计为 0；数量小数可用 / 100% discount and decimal quantities', async () => {
    expect((await add(admin, salesDeal.id, { productId: product.id, quantity: '1.5', discountPercent: '100' })).json.item.lineTotal).toBe('0');
    expect((await add(admin, salesDeal.id, { productId: product.id, quantity: '0.01' })).json.dealAmount).toBe('1.00');
  });

  it.each([[{ sku: '', name: 'x' }], [{ sku: 'a b', name: 'x' }], [{ sku: '中文', name: 'x' }], [{ sku: 'X', name: '' }], [{ sku: 'X', name: 'x', unitPrice: '-1' }], [{ sku: 'X', name: 'x', currency: 'GBP' }], [{ sku: 'X', name: 'x', organizationId: '00000000-0000-4000-8000-000000000000' }]])(
    '非法产品 %j → 400 / invalid products',
    async (body) => {
      expect((await call(products.POST, { token: admin.token, body })).status).toBe(400);
    },
  );

  it('数据库约束：数量 > 0、折扣 0–100、单价非负 / DB CHECK constraints', async () => {
    const base = { organizationId: admin.org.id, dealId: salesDeal.id, productId: product.id, productName: 'x', productSku: 'P-1', unitPrice: '1', lineTotal: '1' };
    await expect(prisma.dealLineItem.create({ data: { ...base, quantity: '0' } })).rejects.toThrow();
    await expect(prisma.dealLineItem.create({ data: { ...base, quantity: '1', discountPercent: '101' } })).rejects.toThrow();
    await expect(prisma.product.create({ data: { organizationId: admin.org.id, sku: 'N', name: 'x', unitPrice: '-1' } })).rejects.toThrow();
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(products.GET)).status).toBe(401);
    expect((await call(dealItems.GET, { params: { id: salesDeal.id } })).status).toBe(401);
  });
});
