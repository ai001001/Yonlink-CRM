/**
 * 供应商与采购单 第一轮：功能测试（供应商新建、同名不区分大小写、修改与审计打码、停用后不能用于新采购单、有采购单不能删除；
 * 采购单：目录产品快照与手工明细、金额与税额、编号连续且删除后不复用、默认币种；由销售订单生成复制明细与收货地址、
 * 单价为 0 不能下单；下单锁定明细并保存汇率快照（人民币、美元、缺汇率）；草稿与已下单的可改字段、终态不可改；
 * 分批收货、超收与重复行、到货状态与时间；有收货不能取消、取消草稿与已下单；只能删除草稿；列表筛选；审计；演示数据）。
 * Vendors and purchase orders round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_PURCHASE_ORDERS, DEMO_VENDORS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as rates from '@/app/api/exchange-rates/route';
import * as products from '@/app/api/products/route';
import * as poItem from '@/app/api/purchase-orders/[id]/route';
import * as poReceive from '@/app/api/purchase-orders/[id]/receive/route';
import * as poStatus from '@/app/api/purchase-orders/[id]/status/route';
import * as pos from '@/app/api/purchase-orders/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as orderStatus from '@/app/api/sales-orders/[id]/status/route';
import * as orders from '@/app/api/sales-orders/route';
import * as vendorItem from '@/app/api/vendors/[id]/route';
import * as vendors from '@/app/api/vendors/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let vendor: { id: string };
let product: { id: string };
const year = new Date().getUTCFullYear();
const newVendor = (body: object) => call(vendors.POST, { token: a.token, body: { name: '供应商', ...body } });
const create = (body: object) => call(pos.POST, { token: a.token, body: { vendorId: vendor.id, subject: '采购', ...body } });
const patch = (id: string, body: object) => call(poItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });
const status = (id: string, body: object) => call(poStatus.POST, { token: a.token, params: { id }, body });
const receive = (id: string, lines: object[]) => call(poReceive.POST, { token: a.token, params: { id }, body: { lines } });
const manual = (extra: object = {}) => ({ productSku: 'M-1', productName: '手工件', unit: '个', quantity: '10', unitCost: '2.50', ...extra });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  vendor = (await newVendor({ name: '宁波铸造', currency: 'CNY', paymentTerms: '月结 30 天' })).json;
  product = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '涡轮壳体', unit: '件', unitPrice: '1000' } })).json;
});

describe('vendors R1', () => {
  it('新建、同名、修改审计打码、停用、有采购单不能删除 / vendor lifecycle', async () => {
    expect(vendor).toMatchObject({ name: '宁波铸造', currency: 'CNY', paymentTerms: '月结 30 天', isActive: true, _count: { purchaseOrders: 0 } });
    const dup = await newVendor({ name: '  宁波铸造 ' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details).toEqual({ name: ['taken'] });
    expect((await newVendor({ name: 'ACME' })).status).toBe(201);
    expect((await newVendor({ name: 'acme' })).status).toBe(409);
    for (const body of [{ name: ' ' }, { email: 'bad' }, { currency: 'GBP' }, { organizationId: a.org.id }]) expect((await newVendor({ name: '新', ...body })).status).toBe(400);
    const up = await call(vendorItem.PATCH, { token: a.token, params: { id: vendor.id }, body: { phone: '0574-88886666', address: '宁波北仑', isActive: false }, method: 'PATCH' });
    expect(up.json.isActive).toBe(false);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'vendor.update', entityId: vendor.id } });
    expect(log.changes).toEqual({ fields: { phone: [null, '057********66'], address: [null, '[redacted]'], isActive: [true, false] } });
    // 停用后不能用于新采购单 / inactive vendors cannot be used
    expect((await create({ lines: [manual()] })).json.error.details).toEqual({ vendorId: ['inactive'] });
    await call(vendorItem.PATCH, { token: a.token, params: { id: vendor.id }, body: { isActive: true }, method: 'PATCH' });
    await create({ lines: [manual()] });
    const del = await call(vendorItem.DELETE, { token: a.token, params: { id: vendor.id }, method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(del.json.error.details).toEqual({ purchaseOrders: ['1'] });
    const acme = (await call(vendors.GET, { token: a.token, query: { q: 'acme' } })).json.items[0];
    expect((await call(vendorItem.DELETE, { token: a.token, params: { id: acme.id }, method: 'DELETE' })).status).toBe(204);
    // 详情列出采购单；列表按启用筛选 / detail lists orders; filter by active
    expect((await call(vendorItem.GET, { token: a.token, params: { id: vendor.id } })).json.purchaseOrders).toHaveLength(1);
    expect((await call(vendors.GET, { token: a.token, query: { active: 'false' } })).json.total).toBe(0);
  });
});

describe('purchase orders R1 drafts', () => {
  it('目录与手工明细、金额税额、编号、默认币种、审计 / lines, totals, numbering', async () => {
    const usd = (await newVendor({ name: '美国供应商', currency: 'USD' })).json;
    const r = await call(pos.POST, {
      token: a.token,
      body: { vendorId: usd.id, subject: '首批采购', taxPercent: '13', expectedDate: '2026-12-31', lines: [{ productId: product.id, quantity: '3', unitCost: '333.33' }, manual()] },
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ poNumber: `PO-${year}-0001`, status: 'DRAFT', currency: 'USD', taxPercent: '13', subtotal: '1024.99', taxAmount: '133.25', total: '1158.24', exchangeRate: null, createdBy: { id: a.user.id } });
    expect(r.json.lines.map((l: { productSku: string; productName: string; unit: string; lineTotal: string; position: number }) => [l.position, l.productSku, l.productName, l.unit, l.lineTotal])).toEqual([
      [1, 'P-1', '涡轮壳体', '件', '999.99'],
      [2, 'M-1', '手工件', '个', '25'],
    ]);
    // 编号：删除草稿后不复用 / numbers are not reused after deleting a draft
    const d2 = (await create({ lines: [manual()] })).json;
    expect(d2.poNumber).toBe(`PO-${year}-0002`);
    expect((await call(poItem.DELETE, { token: a.token, params: { id: d2.id }, method: 'DELETE' })).status).toBe(204);
    expect((await create({ lines: [manual()] })).json.poNumber).toBe(`PO-${year}-0003`);
    for (const lines of [[], [{ quantity: '1', unitCost: '1' }], [manual({ quantity: '0' })], [manual({ unitCost: '-1' })], [{ productId: '00000000-0000-4000-8000-000000000000', quantity: '1', unitCost: '1' }]]) {
      expect((await create({ lines })).status).toBe(400);
    }
    expect((await create({})).json.error.details).toEqual({ lines: ['required'] });
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'purchase' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['purchase.create', 'purchase.create', 'purchase.delete', 'purchase.create']);
    expect(logs[0]!.changes).toMatchObject({ after: { poNumber: `PO-${year}-0001`, total: '1158.24' }, lines: 2 });
  });

  it('由销售订单生成：复制明细与收货地址，单价为 0 不能下单 / from a sales order', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', address: '上海演示路 9 号' } })).json;
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id } })).json;
    await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: product.id, quantity: '4' } });
    const q = (await call(quotes.POST, { token: a.token, body: { dealId: deal.id } })).json;
    await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'SENT' } });
    await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
    const so = (await call(orders.POST, { token: a.token, body: { quoteId: q.id } })).json;
    const r = await create({ salesOrderId: so.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ salesOrder: { id: so.id, orderNumber: so.orderNumber }, deliveryAddress: '上海演示路 9 号', total: '0' });
    expect(r.json.lines).toEqual([expect.objectContaining({ productSku: 'P-1', quantity: '4', unitCost: '0', receivedQuantity: '0' })]);
    const order = await status(r.json.id, { status: 'ORDERED' });
    expect(order.status).toBe(400);
    expect(order.json.error.details).toEqual({ lines: ['zero_cost:1'] });
    // 填写单价后可下单 / order after filling in the cost
    await patch(r.json.id, { lines: [{ productSku: 'P-1', productName: '涡轮壳体', unit: '件', quantity: '4', unitCost: '600' }] });
    expect((await status(r.json.id, { status: 'ORDERED' })).json.status).toBe('ORDERED');
    expect((await call(pos.GET, { token: a.token, query: { salesOrderId: so.id } })).json.total).toBe(1);
    // 已取消的销售订单不能生成 / cancelled sales orders cannot be used
    await call(orderStatus.POST, { token: a.token, params: { id: so.id }, body: { status: 'CANCELLED' } });
    expect((await create({ salesOrderId: so.id })).json.error.details).toEqual({ salesOrderId: ['cancelled'] });
  });
});

describe('purchase orders R1 ordering & receiving', () => {
  it('下单锁定明细与汇率快照（人民币、美元、缺汇率）/ ordering and rate snapshots', async () => {
    await call(rates.PUT, { token: a.token, body: { currency: 'USD', rate: '7.1', effectiveDate: '2026-01-01' }, method: 'PUT' });
    const cny = (await create({ lines: [manual()] })).json;
    const usd = (await create({ currency: 'USD', lines: [manual({ unitCost: '100' })] })).json;
    const eur = (await create({ currency: 'EUR', lines: [manual()] })).json;
    const c = (await status(cny.id, { status: 'ORDERED' })).json;
    expect(c).toMatchObject({ status: 'ORDERED', exchangeRate: '1', baseTotal: '25' });
    expect(c.orderedAt).not.toBeNull();
    expect((await status(usd.id, { status: 'ORDERED' })).json).toMatchObject({ exchangeRate: '7.1', baseTotal: '7100' });
    expect((await status(eur.id, { status: 'ORDERED' })).json).toMatchObject({ exchangeRate: null, baseTotal: null });
    // 已下单：明细等不可改，主题等可改；不能再次下单 / ordered: lines locked, subject editable
    const locked = await patch(cny.id, { lines: [manual()], taxPercent: '5' });
    expect(locked.status).toBe(409);
    expect(locked.json.error.details).toEqual({ taxPercent: ['draft_only'], lines: ['draft_only'] });
    expect((await patch(cny.id, { subject: '改主题', expectedDate: '2027-01-15' })).json.subject).toBe('改主题');
    expect((await status(cny.id, { status: 'ORDERED' })).json.error.details).toEqual({ status: ['invalid_transition'] });
    expect((await status(cny.id, { status: 'RECEIVED' })).status).toBe(400);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'purchase.status', entityId: usd.id } });
    expect(log.changes).toMatchObject({ fields: { status: ['DRAFT', 'ORDERED'], exchangeRate: [null, '7.1'], baseTotal: [null, '7100'] } });
  });

  it('分批收货、超收、到货状态；收货后不能取消；终态不可改 / receiving', async () => {
    const po = (await create({ lines: [manual({ quantity: '10' }), manual({ productSku: 'M-2', quantity: '5' })] })).json;
    const [l1, l2] = po.lines as { id: string }[];
    expect((await receive(po.id, [{ lineId: l1!.id, quantity: '1' }])).json.error.details).toEqual({ status: ['not_ordered'] });
    await status(po.id, { status: 'ORDERED' });
    let r = await receive(po.id, [{ lineId: l1!.id, quantity: '4' }]);
    expect(r.json.status).toBe('PARTIALLY_RECEIVED');
    expect(r.json.lines[0].receivedQuantity).toBe('4');
    expect(r.json.receivedAt).toBeNull();
    expect((await receive(po.id, [{ lineId: l1!.id, quantity: '6.01' }])).json.error.details).toEqual({ lines: ['over:1'] });
    expect((await receive(po.id, [{ lineId: l1!.id, quantity: '1' }, { lineId: l1!.id, quantity: '1' }])).json.error.details).toEqual({ lines: ['duplicate'] });
    expect((await receive(po.id, [{ lineId: '00000000-0000-4000-8000-000000000000', quantity: '1' }])).json.error.details).toEqual({ lineId: ['not_found'] });
    // 部分到货不能取消（已有收货）/ partially received orders cannot be cancelled
    expect((await status(po.id, { status: 'CANCELLED' })).json.error.details).toEqual({ status: ['has_receipts'] });
    r = await receive(po.id, [{ lineId: l1!.id, quantity: '6' }, { lineId: l2!.id, quantity: '5' }]);
    expect(r.json).toMatchObject({ status: 'RECEIVED' });
    expect(r.json.receivedAt).not.toBeNull();
    expect((await patch(po.id, { subject: 'x' })).json.error.details).toEqual({ status: ['final'] });
    expect((await call(poItem.DELETE, { token: a.token, params: { id: po.id }, method: 'DELETE' })).json.error.details).toEqual({ status: ['not_draft'] });
    const logs = await prisma.auditLog.findMany({ where: { action: 'purchase.receive', entityId: po.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.changes)).toEqual([
      { received: [{ sku: 'M-1', quantity: '4' }], status: ['ORDERED', 'PARTIALLY_RECEIVED'] },
      { received: [{ sku: 'M-1', quantity: '6' }, { sku: 'M-2', quantity: '5' }], status: ['PARTIALLY_RECEIVED', 'RECEIVED'] },
    ]);
  });

  it('取消草稿与未收货的已下单（带原因）；部分到货不能取消；列表筛选 / cancel and list', async () => {
    const draft = (await create({ subject: '草稿单', lines: [manual()] })).json;
    const ordered = (await create({ subject: '已下单', lines: [manual()] })).json;
    await status(ordered.id, { status: 'ORDERED' });
    expect((await status(draft.id, { status: 'CANCELLED', reason: '需求取消' })).json).toMatchObject({ status: 'CANCELLED', cancelReason: '需求取消' });
    expect((await status(ordered.id, { status: 'CANCELLED' })).json.status).toBe('CANCELLED');
    expect((await status(ordered.id, { status: 'ORDERED', reason: 'x' })).status).toBe(400);
    const partial = (await create({ subject: '部分到货', lines: [manual({ quantity: '2' })] })).json;
    await status(partial.id, { status: 'ORDERED' });
    await receive(partial.id, [{ lineId: partial.lines[0].id, quantity: '1' }]);
    expect((await status(partial.id, { status: 'CANCELLED' })).json.error.details).toEqual({ status: ['has_receipts'] });
    const names = async (query: Record<string, string>) => (await call(pos.GET, { token: a.token, query })).json.items.map((x: { subject: string }) => x.subject).sort();
    expect(await names({ status: 'CANCELLED' })).toEqual(['已下单', '草稿单'].sort());
    expect(await names({ q: '宁波' })).toHaveLength(3);
    expect(await names({ q: `PO-${year}-0003` })).toEqual(['部分到货']);
    expect(await names({ vendorId: vendor.id, status: 'PARTIALLY_RECEIVED' })).toEqual(['部分到货']);
  });

  it('演示供应商与采购单 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const vs = await prisma.vendor.findMany({ where: { organizationId: org.id } });
    expect(vs.map((v) => v.name).sort()).toEqual(DEMO_VENDORS.map((v) => v.name).sort());
    const list = await prisma.purchaseOrder.findMany({ where: { organizationId: org.id }, include: { lines: true }, orderBy: { poNumber: 'asc' } });
    expect(list.map((p) => p.status)).toEqual(DEMO_PURCHASE_ORDERS.map((p) => p.status));
    for (const p of list) {
      const sum = p.lines.reduce((s, l) => s + Number(l.lineTotal), 0);
      expect(Number(p.subtotal)).toBeCloseTo(sum, 2);
      expect(p.status === 'DRAFT' ? p.exchangeRate : p.exchangeRate?.toString()).toBe(p.status === 'DRAFT' ? null : p.currency === 'CNY' ? '1' : p.exchangeRate?.toString());
      for (const l of p.lines) expect(Number(l.receivedQuantity)).toBeLessThanOrEqual(Number(l.quantity));
    }
    expect(list.find((p) => p.status === 'ORDERED')!.salesOrderId).not.toBeNull();
    expect((await prisma.documentCounter.findFirstOrThrow({ where: { organizationId: org.id, kind: 'PO' } })).last).toBe(DEMO_PURCHASE_ORDERS.length);
  });
});
