/**
 * 价格表 第一轮：功能测试（新建与校验、同名不区分大小写、阶梯校验、修改与审计、已有产品价格不能改币种、改为固定价清除阶梯；
 * 产品价格的设置、修改、移除与校验；指定客户、替换、取消、停用不能指定、删除价格表清除指定；商机明细按客户默认价格表、
 * 指定价格表、不用价格表取价，阶梯折扣边界，手工单价与折扣覆盖，价格来源快照；取价预览；报价单沿用价格；演示数据）。
 * Price books round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_PRICE_BOOKS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
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
import * as quotes from '@/app/api/quotes/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let p1: { id: string };
let p2: { id: string };
const tiers = [
  { fromQuantity: '10', toQuantity: '49.99', discountPercent: '5' },
  { fromQuantity: '50', toQuantity: null, discountPercent: '10' },
];
const newBook = (body: object) => call(books.POST, { token: a.token, body: { name: '经销商价', ...body } });
const patch = (id: string, body: object) => call(pbItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });
const setPrice = (id: string, productId: string, listPrice: string) => call(pbEntries.PUT, { token: a.token, params: { id }, body: { productId, listPrice }, method: 'PUT' });
const assign = (id: string, accountId: string) => call(pbAccounts.POST, { token: a.token, params: { id }, body: { accountId } });
const addItem = (dealId: string, body: object) => call(dealItems.POST, { token: a.token, params: { id: dealId }, body });
const newAccount = async (name: string) => (await call(accounts.POST, { token: a.token, body: { name } })).json;
const newDeal = async (accountId: string, currency = 'CNY') => (await call(deals.POST, { token: a.token, body: { name: '商机', accountId, currency } })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  p1 = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '涡轮壳体', unitPrice: '1000' } })).json;
  p2 = (await call(products.POST, { token: a.token, body: { sku: 'P-2', name: '垫片', unitPrice: '50' } })).json;
});

describe('price books R1 maintenance', () => {
  it('新建、校验、同名、阶梯规则、修改审计、改币种、改定价方式、列表筛选 / create, validate, update', async () => {
    const r = await newBook({ description: '内部说明' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '经销商价', currency: 'CNY', pricingModel: 'FLAT', isActive: true });
    expect((await newBook({ name: ' 经销商价 ' })).json.error.details).toEqual({ name: ['taken'] });
    expect((await newBook({ name: 'VIP' })).status).toBe(201);
    expect((await newBook({ name: 'vip' })).status).toBe(409);
    // 输入校验 / input validation
    for (const body of [{ name: ' ' }, { currency: 'GBP' }, { pricingModel: 'X' }, { organizationId: a.org.id }, { tiers: [{ fromQuantity: '0', discountPercent: '1' }] }, { tiers: [{ fromQuantity: '1', discountPercent: '101' }] }]) {
      expect((await newBook({ name: '新', pricingModel: 'DIFFERENTIAL', ...body })).status).toBe(400);
    }
    // 阶梯规则 / tier rules
    const tierError = async (body: object) => (await newBook({ name: '阶梯', ...body })).json.error.details;
    expect(await tierError({ tiers })).toEqual({ tiers: ['flat_no_tiers'] });
    expect(await tierError({ pricingModel: 'DIFFERENTIAL' })).toEqual({ tiers: ['required'] });
    expect(await tierError({ pricingModel: 'DIFFERENTIAL', tiers: [{ fromQuantity: '10', toQuantity: '5', discountPercent: '1' }] })).toEqual({ tiers: ['range:1'] });
    expect(await tierError({ pricingModel: 'DIFFERENTIAL', tiers: [{ fromQuantity: '1', toQuantity: null, discountPercent: '1' }, { fromQuantity: '10', toQuantity: null, discountPercent: '2' }] })).toEqual({ tiers: ['open_not_last:1'] });
    // 未排序输入按起始数量排序后再判断重叠 / unsorted input is sorted before the overlap check
    expect(await tierError({ pricingModel: 'DIFFERENTIAL', tiers: [{ fromQuantity: '10', toQuantity: null, discountPercent: '2' }, { fromQuantity: '1', toQuantity: '10', discountPercent: '1' }] })).toEqual({ tiers: ['overlap:1'] });
    const diffBook = await newBook({ name: '阶梯', pricingModel: 'DIFFERENTIAL', tiers: [...tiers].reverse() });
    expect(diffBook.status).toBe(201);
    const detail = (await call(pbItem.GET, { token: a.token, params: { id: diffBook.json.id } })).json;
    expect(detail.tiers.map((t: { fromQuantity: string }) => t.fromQuantity)).toEqual(['10', '50']);
    // 新建审计：说明只记“已修改”，阶梯以文本记录 / create audit: description redacted, tiers as text
    const createLog = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pricebook.create', entityId: diffBook.json.id } });
    expect((createLog.changes as { after: { tiers: string[] } }).after.tiers).toEqual(['10-49.99:5%', '50-:10%']);
    const log1 = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pricebook.create', entityId: r.json.id } });
    expect((log1.changes as { after: { description: string } }).after.description).toBe('[redacted]');

    // 修改：名称、停用；阶梯整体替换；审计 / update name, active state; replace tiers; audit
    const id = r.json.id;
    expect((await patch(id, { name: '经销商价 2026', isActive: false })).json).toMatchObject({ name: '经销商价 2026', isActive: false });
    const up = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pricebook.update', entityId: id } });
    expect(up.changes).toEqual({ fields: { name: ['经销商价', '经销商价 2026'], isActive: [true, false] } });
    expect((await patch(id, { name: 'vip' })).status).toBe(409);
    // 改为阶梯价必须带阶梯；带阶梯后成功 / switching to DIFFERENTIAL needs tiers
    expect((await patch(id, { pricingModel: 'DIFFERENTIAL' })).json.error.details).toEqual({ tiers: ['required'] });
    expect((await patch(id, { pricingModel: 'DIFFERENTIAL', tiers })).status).toBe(200);
    const sw = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pricebook.update', entityId: id }, orderBy: { createdAt: 'desc' } });
    expect(sw.changes).toEqual({ fields: { pricingModel: ['FLAT', 'DIFFERENTIAL'], tiers: [[], ['10-49.99:5%', '50-:10%']] } });
    // 只改说明时沿用阶梯；改回固定价清除阶梯 / a description-only change keeps tiers; FLAT drops them
    expect((await patch(id, { description: '新说明' })).status).toBe(200);
    expect(await prisma.priceBookTier.count({ where: { priceBookId: id } })).toBe(2);
    expect((await patch(id, { pricingModel: 'FLAT' })).status).toBe(200);
    expect(await prisma.priceBookTier.count({ where: { priceBookId: id } })).toBe(0);
    // 无产品价格时可改币种，有产品价格后不能改 / currency fixed once priced
    expect((await patch(id, { currency: 'USD' })).json.currency).toBe('USD');
    expect((await patch(id, { currency: 'CNY' })).json.currency).toBe('CNY');
    await setPrice(id, p1.id, '900');
    const cur = await patch(id, { currency: 'USD' });
    expect(cur.status).toBe(409);
    expect(cur.json.error.details).toEqual({ currency: ['has_entries'] });

    // 列表：启用筛选、币种、搜索、计数 / list filters and counts
    const names = async (query: Record<string, string>) => (await call(books.GET, { token: a.token, query })).json.items.map((b: { name: string }) => b.name);
    expect(await names({ active: 'false' })).toEqual(['经销商价 2026']);
    expect(await names({ q: '阶梯' })).toEqual(['阶梯']);
    expect(await names({ currency: 'USD' })).toEqual([]);
    const listed = (await call(books.GET, { token: a.token, query: { q: '2026' } })).json.items[0];
    expect(listed._count).toEqual({ entries: 1, accounts: 0 });
  });

  it('产品价格：设置、修改、相同价格不重复审计、校验、移除 / entries', async () => {
    const book = (await newBook({})).json;
    const r = await setPrice(book.id, p1.id, '880');
    expect(r.status).toBe(200);
    expect(r.json.listPrice).toBe('880');
    expect((await setPrice(book.id, p1.id, '860.50')).json.listPrice).toBe('860.5');
    await setPrice(book.id, p1.id, '860.5');
    const logs = await prisma.auditLog.findMany({ where: { action: 'pricebook.set_price', entityId: book.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.changes)).toEqual([
      { sku: 'P-1', listPrice: [null, '880'] },
      { sku: 'P-1', listPrice: ['880', '860.5'] },
    ]);
    expect(await prisma.priceBookEntry.count({ where: { priceBookId: book.id } })).toBe(1);
    // 详情：产品价格附目录价 / detail shows the catalogue price
    const detail = (await call(pbItem.GET, { token: a.token, params: { id: book.id } })).json;
    expect(detail.entries).toHaveLength(1);
    expect(detail.entries[0]).toMatchObject({ listPrice: '860.5', product: { sku: 'P-1', unitPrice: '1000', currency: 'CNY' } });
    // 校验：产品不存在、停用、币种不同、价格格式 / validation
    const usd = (await call(products.POST, { token: a.token, body: { sku: 'U-1', name: '美元件', unitPrice: '10', currency: 'USD' } })).json;
    expect((await setPrice(book.id, usd.id, '9')).json.error.details).toEqual({ productId: ['currency_mismatch'] });
    await call(productItem.PATCH, { token: a.token, params: { id: p2.id }, body: { isActive: false }, method: 'PATCH' });
    expect((await setPrice(book.id, p2.id, '9')).json.error.details).toEqual({ productId: ['inactive'] });
    expect((await setPrice(book.id, '00000000-0000-4000-8000-000000000000', '9')).json.error.details).toEqual({ productId: ['not_found'] });
    for (const price of ['-1', 'abc', '1.234']) expect((await setPrice(book.id, p1.id, price)).status).toBe(400);
    // 移除 / remove
    expect((await call(pbEntry.DELETE, { token: a.token, params: { id: book.id, productId: p1.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(pbEntry.DELETE, { token: a.token, params: { id: book.id, productId: p1.id }, method: 'DELETE' })).status).toBe(404);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'pricebook.remove_price' } })).changes).toEqual({ sku: 'P-1', listPrice: '860.5' });
  });

  it('指定客户、替换、取消、停用不能指定、删除价格表清除指定 / account assignment', async () => {
    const b1 = (await newBook({ name: '一' })).json;
    const b2 = (await newBook({ name: '二' })).json;
    const acc = await newAccount('华东客户');
    expect((await assign(b1.id, acc.id)).json).toEqual({ id: acc.id, name: '华东客户' });
    expect((await call(accountItem.GET, { token: a.token, params: { id: acc.id } })).json.priceBook).toEqual({ id: b1.id, name: '一', isActive: true });
    // 重复指定不产生审计 / assigning again is a no-op
    await assign(b1.id, acc.id);
    expect(await prisma.auditLog.count({ where: { action: 'pricebook.assign' } })).toBe(1);
    // 指定另一张价格表即替换 / assigning another book replaces it
    await assign(b2.id, acc.id);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).priceBookId).toBe(b2.id);
    const replaced = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pricebook.assign', entityId: b2.id } });
    expect(replaced.changes).toEqual({ account: '华东客户', replaced: '一' });
    const d2 = (await call(pbItem.GET, { token: a.token, params: { id: b2.id } })).json;
    expect(d2.accounts).toEqual([{ id: acc.id, name: '华东客户' }]);
    expect(d2._count.accounts).toBe(1);
    // 取消：未指定给该价格表时 404 / unassign; 404 when not assigned to this book
    expect((await call(pbAccount.DELETE, { token: a.token, params: { id: b1.id, accountId: acc.id }, method: 'DELETE' })).status).toBe(404);
    expect((await call(pbAccount.DELETE, { token: a.token, params: { id: b2.id, accountId: acc.id }, method: 'DELETE' })).status).toBe(204);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).priceBookId).toBeNull();
    // 停用的价格表不能指定；不存在的客户 / inactive books cannot be assigned; unknown account
    await patch(b1.id, { isActive: false });
    expect((await assign(b1.id, acc.id)).json.error.details).toEqual({ priceBookId: ['inactive'] });
    expect((await assign(b2.id, '00000000-0000-4000-8000-000000000000')).json.error.details).toEqual({ accountId: ['not_found'] });
    // 删除价格表：清除客户指定，审计记录客户数 / delete clears accounts and audits the count
    const acc2 = await newAccount('华南客户');
    await assign(b2.id, acc.id);
    await assign(b2.id, acc2.id);
    await setPrice(b2.id, p1.id, '900');
    expect((await call(pbItem.DELETE, { token: a.token, params: { id: b2.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.account.count({ where: { priceBookId: { not: null } } })).toBe(0);
    expect(await prisma.priceBookEntry.count()).toBe(0);
    const del = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pricebook.delete', entityId: b2.id } });
    expect((del.changes as { before: Record<string, unknown> }).before).toMatchObject({ name: '二', entries: 1, accounts: 2 });
    expect((await call(accountItem.GET, { token: a.token, params: { id: acc.id } })).json.priceBook).toBeNull();
  });
});

describe('price books R1 pricing deal items', () => {
  it('客户默认价格表、目录价回退、阶梯边界、手工覆盖、指定与不用价格表、来源快照 / pricing rules', async () => {
    const flat = (await newBook({ name: '经销商价' })).json;
    await setPrice(flat.id, p1.id, '880');
    const volume = (await newBook({ name: '批量阶梯', pricingModel: 'DIFFERENTIAL', tiers })).json;
    await setPrice(volume.id, p1.id, '1000');
    await setPrice(volume.id, p2.id, '45');
    const acc = await newAccount('经销商');
    await assign(flat.id, acc.id);
    const deal = await newDeal(acc.id);

    // 客户默认价格表（固定价）/ the account's flat book
    const i1 = (await addItem(deal.id, { productId: p1.id, quantity: '2' })).json.item;
    expect(i1).toMatchObject({ unitPrice: '880', discountPercent: '0', lineTotal: '1760', priceBookName: '经销商价' });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'deal.add_item' } })).changes).toMatchObject({ sku: 'P-1', unitPrice: '880', priceBook: '经销商价' });
    // 价格表中没有的产品取目录价 / unlisted products fall back to the catalogue price
    const i2 = (await addItem(deal.id, { productId: p2.id, quantity: '1' })).json.item;
    expect(i2).toMatchObject({ unitPrice: '50', discountPercent: '0', priceBookName: null });
    // 手工单价不算价格表价；手工折扣仍用价格表单价 / a manual price drops the book; a manual discount keeps the book price
    expect((await addItem(deal.id, { productId: p1.id, quantity: '1', unitPrice: '700' })).json.item).toMatchObject({ unitPrice: '700', priceBookName: null });
    expect((await addItem(deal.id, { productId: p1.id, quantity: '1', discountPercent: '3' })).json.item).toMatchObject({ unitPrice: '880', discountPercent: '3', lineTotal: '853.6', priceBookName: '经销商价' });
    // 不用价格表 / no price book
    expect((await addItem(deal.id, { productId: p1.id, quantity: '1', priceBookId: null })).json.item).toMatchObject({ unitPrice: '1000', priceBookName: null });

    // 指定阶梯价格表：区间边界 / explicit differential book: tier boundaries
    const tiered = async (quantity: string) => (await addItem(deal.id, { productId: p2.id, quantity, priceBookId: volume.id })).json.item;
    expect(await tiered('9.99')).toMatchObject({ unitPrice: '45', discountPercent: '0', lineTotal: '449.55', priceBookName: '批量阶梯' });
    expect(await tiered('10')).toMatchObject({ discountPercent: '5', lineTotal: '427.5' });
    expect(await tiered('49.99')).toMatchObject({ discountPercent: '5', lineTotal: '2137.07' });
    expect(await tiered('50')).toMatchObject({ discountPercent: '10', lineTotal: '2025' });
    expect(await tiered('1000')).toMatchObject({ discountPercent: '10', lineTotal: '40500' });

    // 指定价格表的错误 / explicit book errors
    const p3 = (await call(products.POST, { token: a.token, body: { sku: 'P-3', name: '未定价', unitPrice: '5' } })).json;
    const err = async (body: object) => (await addItem(deal.id, { productId: p3.id, quantity: '1', ...body })).json.error.details;
    expect(await err({ priceBookId: volume.id })).toEqual({ priceBookId: ['product_not_listed'] });
    expect(await err({ priceBookId: '00000000-0000-4000-8000-000000000000' })).toEqual({ priceBookId: ['not_found'] });
    const usdBook = (await newBook({ name: '美元', currency: 'USD' })).json;
    expect(await err({ priceBookId: usdBook.id })).toEqual({ priceBookId: ['currency_mismatch'] });
    await patch(volume.id, { isActive: false });
    expect(await err({ priceBookId: volume.id })).toEqual({ priceBookId: ['inactive'] });

    // 客户默认价格表停用后取目录价；其他币种的商机不用该价格表 / inactive default → catalogue; other-currency deals skip it
    await patch(flat.id, { isActive: false });
    expect((await addItem(deal.id, { productId: p1.id, quantity: '1' })).json.item).toMatchObject({ unitPrice: '1000', priceBookName: null });
    await patch(flat.id, { isActive: true });
    const usdDeal = await newDeal(acc.id, 'USD');
    const usdProduct = (await call(products.POST, { token: a.token, body: { sku: 'U-1', name: '美元件', unitPrice: '10', currency: 'USD' } })).json;
    expect((await addItem(usdDeal.id, { productId: usdProduct.id, quantity: '1' })).json.item).toMatchObject({ unitPrice: '10', priceBookName: null });

    // 列表返回价格来源 / the item list carries the source
    const list = (await call(dealItems.GET, { token: a.token, params: { id: deal.id } })).json.items;
    expect(list[0].priceBookName).toBe('经销商价');
  });

  it('取价预览与新增一致；报价单沿用价格表价 / preview and quotes', async () => {
    const volume = (await newBook({ name: '批量阶梯', pricingModel: 'DIFFERENTIAL', tiers })).json;
    await setPrice(volume.id, p1.id, '900');
    const acc = await newAccount('客户');
    await assign(volume.id, acc.id);
    const deal = await newDeal(acc.id);
    const preview = async (query: Record<string, string>) => (await call(dealPrice.GET, { token: a.token, params: { id: deal.id }, query: { productId: p1.id, ...query } })).json;
    expect(await preview({ quantity: '20' })).toEqual({ unitPrice: '900.00', discountPercent: '5.00', priceBook: { id: volume.id, name: '批量阶梯' }, lineTotal: '17100.00', currency: 'CNY' });
    expect(await preview({ quantity: '20', priceBookId: 'none' })).toEqual({ unitPrice: '1000.00', discountPercent: '0.00', priceBook: null, lineTotal: '20000.00', currency: 'CNY' });
    expect((await call(dealPrice.GET, { token: a.token, params: { id: deal.id }, query: { productId: p1.id, quantity: '0' } })).status).toBe(400);
    // 预览不写数据 / preview writes nothing
    expect(await prisma.dealLineItem.count()).toBe(0);
    const added = (await addItem(deal.id, { productId: p1.id, quantity: '20' })).json;
    expect(added.item.lineTotal).toBe('17100');
    expect(added.dealAmount).toBe('17100.00');
    // 报价单复制明细价格 / quotes copy the line prices
    const q = (await call(quotes.POST, { token: a.token, body: { dealId: deal.id } })).json;
    expect(q.lines[0]).toMatchObject({ unitPrice: '900', discountPercent: '5', lineTotal: '17100' });
    // 删除价格表后已有明细不变 / existing items survive deleting the book
    await call(pbItem.DELETE, { token: a.token, params: { id: volume.id }, method: 'DELETE' });
    const item = await prisma.dealLineItem.findFirstOrThrow();
    expect(item.unitPrice.toString()).toBe('900');
    expect(item.priceBookName).toBe('批量阶梯');
  });

  it('演示价格表 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const list = await prisma.priceBook.findMany({ where: { organizationId: org.id }, include: { entries: { include: { product: true } }, tiers: true, accounts: true } });
    expect(list.map((b) => b.name).sort()).toEqual(DEMO_PRICE_BOOKS.map((b) => b.name).sort());
    for (const seed of DEMO_PRICE_BOOKS) {
      const b = list.find((x) => x.name === seed.name)!;
      expect(b.isActive).toBe(seed.isActive);
      expect(b.accounts).toHaveLength(seed.accounts.length);
      expect(b.tiers).toHaveLength(seed.tiers.length);
      if (!seed.ratio) expect(b.entries).toHaveLength(0);
      for (const e of b.entries) {
        expect(e.product.currency).toBe(b.currency);
        expect(e.listPrice.toString()).toBe(e.product.unitPrice.mul(seed.ratio!).toDecimalPlaces(2).toString());
      }
    }
    // 再次重置可重复执行 / resetting again works
    await seedDemo({ reset: true });
    expect(await prisma.priceBook.count({ where: { organizationId: org.id } })).toBe(DEMO_PRICE_BOOKS.length);
  });
});
