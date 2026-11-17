/**
 * 价格表 第二轮：集成测试（角色权限：所有人可查看、仅管理员与经理可维护；销售代表只看到自己可见的适用客户、为自己的商机
 * 添加产品时同样按客户价格表取价；跨组织隔离；客户不能通过客户接口自行指定价格表；回收站恢复客户时价格表已删除则置空；
 * 删除产品时其价格随之删除；并发设置同一产品价格只保留一条；审计日志接口按价格表筛选）。
 * Price books round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealPrice from '@/app/api/deals/[id]/price/route';
import * as deals from '@/app/api/deals/route';
import * as pbAccount from '@/app/api/price-books/[id]/accounts/[accountId]/route';
import * as pbAccounts from '@/app/api/price-books/[id]/accounts/route';
import * as pbEntry from '@/app/api/price-books/[id]/entries/[productId]/route';
import * as pbEntries from '@/app/api/price-books/[id]/entries/route';
import * as pbItem from '@/app/api/price-books/[id]/route';
import * as books from '@/app/api/price-books/route';
import * as productItem from '@/app/api/products/[id]/route';
import * as products from '@/app/api/products/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales: Who & { user: { id: string } };
let viewer: Who;
let book: { id: string };
let product: { id: string };

const setPrice = (who: Who, id: string, productId: string, listPrice: string) => call(pbEntries.PUT, { token: who.token, params: { id }, body: { productId, listPrice }, method: 'PUT' });
const assign = (who: Who, id: string, accountId: string) => call(pbAccounts.POST, { token: who.token, params: { id }, body: { accountId } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
  product = (await call(products.POST, { token: admin.token, body: { sku: 'P-1', name: '涡轮壳体', unitPrice: '1000' } })).json;
  book = (await call(books.POST, { token: admin.token, body: { name: '经销商价' } })).json;
  await setPrice(admin, book.id, product.id, '850');
});

describe('price books R2 permissions', () => {
  it('所有人可查看；销售与只读不能维护；经理可以 / read for all, manage for admins and managers', async () => {
    for (const who of [sales, viewer]) {
      expect((await call(books.GET, { token: who.token })).json.total).toBe(1);
      expect((await call(pbItem.GET, { token: who.token, params: { id: book.id } })).json.entries).toHaveLength(1);
    }
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    for (const who of [sales, viewer]) {
      for (const r of [
        await call(books.POST, { token: who.token, body: { name: '我的价' } }),
        await call(pbItem.PATCH, { token: who.token, params: { id: book.id }, body: { name: 'x' }, method: 'PATCH' }),
        await call(pbItem.DELETE, { token: who.token, params: { id: book.id }, method: 'DELETE' }),
        await setPrice(who, book.id, product.id, '1'),
        await call(pbEntry.DELETE, { token: who.token, params: { id: book.id, productId: product.id }, method: 'DELETE' }),
        await assign(who, book.id, acc.id),
        await call(pbAccount.DELETE, { token: who.token, params: { id: book.id, accountId: acc.id }, method: 'DELETE' }),
      ]) {
        expect(r.status).toBe(403);
      }
    }
    expect((await prisma.priceBookEntry.findFirstOrThrow()).listPrice.toString()).toBe('850');
    expect(await prisma.priceBook.count()).toBe(1);
    // 经理可维护 / managers can
    expect((await call(books.POST, { token: manager.token, body: { name: '经理价' } })).status).toBe(201);
    expect((await setPrice(manager, book.id, product.id, '820')).status).toBe(200);
    expect((await assign(manager, book.id, acc.id)).status).toBe(200);
    // 初始化 2 条（新建、设置价格）+ 经理 3 条 / 2 from setup (create, set price) + 3 by the manager
    expect(await prisma.auditLog.count({ where: { entityType: 'pricebook', action: { in: ['pricebook.create', 'pricebook.set_price', 'pricebook.assign'] } } })).toBe(5);
  });

  it('客户接口不能自行指定价格表；销售代表的商机同样按客户价格表取价 / no self-assignment; sales deals use the book', async () => {
    const own = (await call(accounts.POST, { token: sales.token, body: { name: '销售的客户' } })).json;
    const notOwn = (await call(accounts.POST, { token: admin.token, body: { name: '别人的客户' } })).json;
    // 客户新建、修改不接受 priceBookId / accounts reject priceBookId
    expect((await call(accounts.POST, { token: sales.token, body: { name: '新客户', priceBookId: book.id } })).status).toBe(400);
    expect((await call(accountItem.PATCH, { token: sales.token, params: { id: own.id }, body: { priceBookId: book.id }, method: 'PATCH' })).status).toBe(400);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: own.id } })).priceBookId).toBeNull();
    await assign(admin, book.id, own.id);
    await assign(admin, book.id, notOwn.id);
    // 销售代表只看到自己可见的适用客户 / sales see only their visible accounts
    expect((await call(pbItem.GET, { token: sales.token, params: { id: book.id } })).json.accounts.map((x: { name: string }) => x.name)).toEqual(['销售的客户']);
    expect((await call(pbItem.GET, { token: admin.token, params: { id: book.id } })).json.accounts).toHaveLength(2);
    expect((await call(accountItem.GET, { token: sales.token, params: { id: own.id } })).json.priceBook.name).toBe('经销商价');
    // 销售为自己的商机添加产品：按客户价格表 / a sales rep's own deal uses the account book
    const deal = (await call(deals.POST, { token: sales.token, body: { name: '销售商机', accountId: own.id } })).json;
    const r = await call(dealItems.POST, { token: sales.token, params: { id: deal.id }, body: { productId: product.id, quantity: '2' } });
    expect(r.json.item).toMatchObject({ unitPrice: '850', priceBookName: '经销商价' });
    // 预览需要商机可见 / preview needs a visible deal
    const adminDeal = (await call(deals.POST, { token: admin.token, body: { name: '管理员商机', accountId: notOwn.id } })).json;
    expect((await call(dealPrice.GET, { token: sales.token, params: { id: adminDeal.id }, query: { productId: product.id, quantity: '1' } })).status).toBe(404);
    expect((await call(dealPrice.GET, { token: viewer.token, params: { id: adminDeal.id }, query: { productId: product.id, quantity: '1' } })).json.unitPrice).toBe('850.00');
    // 只读用户不能添加明细 / read-only users cannot add items
    expect((await call(dealItems.POST, { token: viewer.token, params: { id: adminDeal.id }, body: { productId: product.id, quantity: '1' } })).status).toBe(403);
  });
});

describe('price books R2 isolation & consistency', () => {
  it('跨组织隔离 / tenant isolation', async () => {
    const bAcc = (await call(accounts.POST, { token: other.token, body: { name: 'B 客户' } })).json;
    const bProduct = (await call(products.POST, { token: other.token, body: { sku: 'B-1', name: 'B 产品', unitPrice: '10' } })).json;
    const bDeal = (await call(deals.POST, { token: other.token, body: { name: 'B 商机', accountId: bAcc.id } })).json;
    expect((await call(books.GET, { token: other.token })).json.total).toBe(0);
    expect((await call(pbItem.GET, { token: other.token, params: { id: book.id } })).status).toBe(404);
    expect((await call(pbItem.PATCH, { token: other.token, params: { id: book.id }, body: { name: 'x' }, method: 'PATCH' })).status).toBe(404);
    expect((await setPrice(other, book.id, bProduct.id, '1')).status).toBe(404);
    expect((await assign(other, book.id, bAcc.id)).status).toBe(404);
    // B 的价格表不能用 A 的产品、客户 / B's book cannot use A's product or account
    const bBook = (await call(books.POST, { token: other.token, body: { name: '经销商价' } })).json;
    expect(bBook.name).toBe('经销商价');
    expect((await setPrice(other, bBook.id, product.id, '1')).json.error.details).toEqual({ productId: ['not_found'] });
    const aAcc = (await call(accounts.POST, { token: admin.token, body: { name: 'A 客户' } })).json;
    expect((await assign(other, bBook.id, aAcc.id)).json.error.details).toEqual({ accountId: ['not_found'] });
    // B 的商机不能用 A 的价格表 / B's deal cannot use A's book
    const r = await call(dealItems.POST, { token: other.token, params: { id: bDeal.id }, body: { productId: bProduct.id, quantity: '1', priceBookId: book.id } });
    expect(r.json.error.details).toEqual({ priceBookId: ['not_found'] });
    // 数据库层面也不能跨组织指定（复合外键）/ composite FKs block cross-tenant links at the database too
    await expect(prisma.account.update({ where: { id: bAcc.id }, data: { priceBookId: book.id } })).rejects.toThrow();
    await expect(prisma.priceBookEntry.create({ data: { organizationId: other.org.id, priceBookId: bBook.id, productId: product.id, listPrice: '1' } })).rejects.toThrow();
  });

  it('回收站恢复客户：价格表仍在则保留，已删除则置空 / account restore keeps or clears the book', async () => {
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '待删除客户' } })).json;
    await assign(admin, book.id, acc.id);
    const removeAndRestore = async () => {
      expect((await call(accountItem.DELETE, { token: admin.token, params: { id: acc.id }, method: 'DELETE' })).status).toBe(204);
      const item = (await call(bin.GET, { token: admin.token, query: { entityType: 'account' } })).json.items[0];
      return call(restore.POST, { token: admin.token, params: { id: item.id } });
    };
    const r1 = await removeAndRestore();
    expect(r1.status).toBe(200);
    expect(r1.json.skipped).not.toContain('priceBook');
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).priceBookId).toBe(book.id);
    // 删除客户后再删除价格表，恢复时置空 / delete the account, then the book: restore clears it
    expect((await call(accountItem.DELETE, { token: admin.token, params: { id: acc.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(pbItem.DELETE, { token: admin.token, params: { id: book.id }, method: 'DELETE' })).status).toBe(204);
    const item = (await call(bin.GET, { token: admin.token, query: { entityType: 'account' } })).json.items[0];
    const r2 = await call(restore.POST, { token: admin.token, params: { id: item.id } });
    expect(r2.status).toBe(200);
    expect(r2.json.skipped).toContain('priceBook');
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).priceBookId).toBeNull();
  });

  it('删除产品时价格随之删除；有商机明细的产品仍不能删除 / product deletion', async () => {
    expect((await call(productItem.DELETE, { token: admin.token, params: { id: product.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.priceBookEntry.count()).toBe(0);
    const p2 = (await call(products.POST, { token: admin.token, body: { sku: 'P-2', name: '在用', unitPrice: '10' } })).json;
    await setPrice(admin, book.id, p2.id, '9');
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: admin.token, body: { name: '商机', accountId: acc.id } })).json;
    await call(dealItems.POST, { token: admin.token, params: { id: deal.id }, body: { productId: p2.id, quantity: '1', priceBookId: book.id } });
    expect((await call(productItem.DELETE, { token: admin.token, params: { id: p2.id }, method: 'DELETE' })).status).toBe(409);
    expect(await prisma.priceBookEntry.count()).toBe(1);
  });

  it('并发设置同一产品价格只保留一条；审计日志接口按价格表筛选 / concurrent upserts; audit filter', async () => {
    const p2 = (await call(products.POST, { token: admin.token, body: { sku: 'P-2', name: '并发', unitPrice: '10' } })).json;
    const results = await Promise.all(['11', '12', '13', '14', '15'].map((price) => setPrice(admin, book.id, p2.id, price)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const entries = await prisma.priceBookEntry.findMany({ where: { productId: p2.id } });
    expect(entries).toHaveLength(1);
    expect(['11', '12', '13', '14', '15']).toContain(entries[0]!.listPrice.toString());
    const logs = (await call(auditLogs.GET, { token: admin.token, query: { entityType: 'pricebook' } })).json;
    expect(logs.items.length).toBeGreaterThanOrEqual(3);
    expect(logs.items.every((l: { entityType: string }) => l.entityType === 'pricebook')).toBe(true);
    expect((await call(auditLogs.GET, { token: admin.token, query: { entityType: 'pricebook', action: 'pricebook.set_price' } })).json.items.length).toBeGreaterThanOrEqual(2);
  });
});
