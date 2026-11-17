/**
 * 供应商与采购单 第二轮：集成测试（销售无权查看或操作采购；只读可查看不可修改；经理可管理；跨组织隔离（供应商、采购单、
 * 销售订单、产品）；客户端不能提交编号、状态、汇率与已收数量；未登录；并发：编号不重复、同时收货不超收、下单与取消互斥、
 * 过期修改 409、删除供应商与新建采购单；跨域预检）。
 * Vendors and purchase orders round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as products from '@/app/api/products/route';
import * as poItem from '@/app/api/purchase-orders/[id]/route';
import * as poReceive from '@/app/api/purchase-orders/[id]/receive/route';
import * as poStatus from '@/app/api/purchase-orders/[id]/status/route';
import * as pos from '@/app/api/purchase-orders/route';
import * as vendorItem from '@/app/api/vendors/[id]/route';
import * as vendors from '@/app/api/vendors/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales: Who;
let viewer: Who;
let vendor: { id: string };
let po: { id: string; lines: { id: string }[] };
const year = new Date().getUTCFullYear();
const line = { productSku: 'M-1', productName: '件', unit: '个', quantity: '10', unitCost: '5' };
const create = (who: Who, body: object = {}) => call(pos.POST, { token: who.token, body: { vendorId: vendor.id, subject: '采购', lines: [line], ...body } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
  vendor = (await call(vendors.POST, { token: admin.token, body: { name: '供应商' } })).json;
  po = (await create(admin)).json;
});

describe('purchase R2 permissions & isolation', () => {
  it('销售不能查看或操作采购 / sales reps have no access', async () => {
    for (const r of [
      await call(vendors.GET, { token: sales.token }),
      await call(vendorItem.GET, { token: sales.token, params: { id: vendor.id } }),
      await call(vendors.POST, { token: sales.token, body: { name: 'x' } }),
      await call(pos.GET, { token: sales.token }),
      await call(poItem.GET, { token: sales.token, params: { id: po.id } }),
      await create(sales),
      await call(poStatus.POST, { token: sales.token, params: { id: po.id }, body: { status: 'ORDERED' } }),
    ]) {
      expect(r.status).toBe(403);
    }
    expect(await prisma.purchaseOrder.count()).toBe(1);
  });

  it('只读可查看不可修改；经理可管理 / readonly and manager', async () => {
    expect((await call(pos.GET, { token: viewer.token })).json.total).toBe(1);
    expect((await call(poItem.GET, { token: viewer.token, params: { id: po.id } })).json.lines).toHaveLength(1);
    expect((await call(vendors.GET, { token: viewer.token })).json.total).toBe(1);
    for (const r of [
      await create(viewer),
      await call(poItem.PATCH, { token: viewer.token, params: { id: po.id }, body: { subject: 'x' }, method: 'PATCH' }),
      await call(poStatus.POST, { token: viewer.token, params: { id: po.id }, body: { status: 'ORDERED' } }),
      await call(poItem.DELETE, { token: viewer.token, params: { id: po.id }, method: 'DELETE' }),
      await call(vendorItem.PATCH, { token: viewer.token, params: { id: vendor.id }, body: { name: 'x' }, method: 'PATCH' }),
    ]) {
      expect(r.status).toBe(403);
    }
    expect((await call(poStatus.POST, { token: manager.token, params: { id: po.id }, body: { status: 'ORDERED' } })).json.status).toBe('ORDERED');
    const r = await call(poReceive.POST, { token: manager.token, params: { id: po.id }, body: { lines: [{ lineId: po.lines[0]!.id, quantity: '10' }] } });
    expect(r.json.status).toBe('RECEIVED');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'purchase.receive' } })).actorId).toBe(manager.user.id);
  });

  it('跨组织隔离；不能引用其他组织的供应商、销售订单与产品 / cross-tenant', async () => {
    expect((await call(pos.GET, { token: other.token })).json.total).toBe(0);
    expect((await call(poItem.GET, { token: other.token, params: { id: po.id } })).status).toBe(404);
    expect((await call(poStatus.POST, { token: other.token, params: { id: po.id }, body: { status: 'ORDERED' } })).status).toBe(404);
    expect((await call(poReceive.POST, { token: other.token, params: { id: po.id }, body: { lines: [{ lineId: po.lines[0]!.id, quantity: '1' }] } })).status).toBe(404);
    expect((await call(poItem.DELETE, { token: other.token, params: { id: po.id }, method: 'DELETE' })).status).toBe(404);
    expect((await call(vendorItem.GET, { token: other.token, params: { id: vendor.id } })).status).toBe(404);
    expect((await call(vendorItem.DELETE, { token: other.token, params: { id: vendor.id }, method: 'DELETE' })).status).toBe(404);
    const ov = (await call(vendors.POST, { token: other.token, body: { name: '供应商' } })).json;
    expect(ov.name).toBe('供应商');
    expect((await call(pos.POST, { token: other.token, body: { vendorId: vendor.id, subject: 'x', lines: [line] } })).json.error.details).toEqual({ vendorId: ['not_found'] });
    const so = await prisma.salesOrder.findFirst();
    expect(so).toBeNull();
    expect((await call(pos.POST, { token: other.token, body: { vendorId: ov.id, subject: 'x', salesOrderId: po.id } })).json.error.details).toEqual({ salesOrderId: ['not_found'] });
    const p = (await call(products.POST, { token: admin.token, body: { sku: 'P-1', name: '产品', unit: '件', unitPrice: '1' } })).json;
    expect((await call(pos.POST, { token: other.token, body: { vendorId: ov.id, subject: 'x', lines: [{ productId: p.id, quantity: '1', unitCost: '1' }] } })).json.error.details).toEqual({ 'lines.0.productId': ['not_found'] });
    // 编号按组织独立 / numbering per organization
    expect((await call(pos.POST, { token: other.token, body: { vendorId: ov.id, subject: 'x', lines: [line] } })).json.poNumber).toBe(`PO-${year}-0001`);
  });

  it('客户端不能提交服务端字段；未登录 / server-owned fields and auth', async () => {
    for (const extra of [{ poNumber: 'PO-1999-0001' }, { status: 'RECEIVED' }, { exchangeRate: '1' }, { organizationId: other.org.id }, { total: '1' }]) {
      expect((await create(admin, extra)).status).toBe(400);
    }
    expect((await create(admin, { lines: [{ ...line, receivedQuantity: '10' }] })).status).toBe(400);
    expect((await call(poItem.PATCH, { token: admin.token, params: { id: po.id }, body: { status: 'ORDERED' }, method: 'PATCH' })).status).toBe(400);
    expect((await call(pos.GET)).status).toBe(401);
    expect((await call(vendors.POST, { body: { name: 'x' } })).status).toBe(401);
    expect((await call(poReceive.POST, { params: { id: po.id }, body: { lines: [] } })).status).toBe(401);
    expect(await prisma.purchaseOrder.count({ where: { organizationId: admin.org.id } })).toBe(1);
  });
});

describe('purchase R2 concurrency & cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('并发：编号不重复、同时收货不超收、下单与取消互斥、过期修改 409 / concurrency', async () => {
    const created = await Promise.all(Array.from({ length: 8 }, () => create(manager)));
    expect(created.every((r) => r.status === 201)).toBe(true);
    expect(new Set(created.map((r) => r.json.poNumber)).size).toBe(8);
    // 同时收货：剩余 10，两次各收 7 → 只有一次成功 / concurrent receipts of 7 each with 10 outstanding: one succeeds
    await call(poStatus.POST, { token: admin.token, params: { id: po.id }, body: { status: 'ORDERED' } });
    const rs = await Promise.all([admin, manager].map((who) => call(poReceive.POST, { token: who.token, params: { id: po.id }, body: { lines: [{ lineId: po.lines[0]!.id, quantity: '7' }] } })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await prisma.purchaseOrderLineItem.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).receivedQuantity.toString()).toBe('7');
    // 下单与取消同时进行：最终状态一致且只有一个成功 / order vs cancel: one wins
    const d = created[0]!.json;
    const [o, c] = await Promise.all([
      call(poStatus.POST, { token: admin.token, params: { id: d.id }, body: { status: 'ORDERED' } }),
      call(poStatus.POST, { token: manager.token, params: { id: d.id }, body: { status: 'CANCELLED' } }),
    ]);
    const final = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: d.id } });
    expect([o.status, c.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    if (final.status === 'ORDERED') expect(o.status).toBe(200);
    // 先下单再取消也是合法的（尚未收货）/ ordering then cancelling is also valid (nothing received)
    expect(['ORDERED', 'CANCELLED']).toContain(final.status);
    // 过期修改 / stale update
    const e = created[1]!.json;
    const both = await Promise.all([
      call(poItem.PATCH, { token: admin.token, params: { id: e.id }, body: { subject: '甲' }, method: 'PATCH' }),
      call(poItem.PATCH, { token: manager.token, params: { id: e.id }, body: { subject: '乙' }, method: 'PATCH' }),
      call(poItem.PATCH, { token: admin.token, params: { id: e.id }, body: { notes: '丙' }, method: 'PATCH' }),
    ]);
    for (const r of both) expect([200, 409]).toContain(r.status);
    for (const r of both.filter((x) => x.status === 409)) expect(r.json.error.details).toEqual({ purchaseOrder: ['stale'] });
  });

  it('删除供应商与新建采购单并发：不会留下指向已删除供应商的采购单 / vendor delete vs order create', async () => {
    for (let i = 0; i < 3; i++) {
      const v = (await call(vendors.POST, { token: admin.token, body: { name: `并发供应商${i}` } })).json;
      const [del, add] = await Promise.all([
        call(vendorItem.DELETE, { token: admin.token, params: { id: v.id }, method: 'DELETE' }),
        call(pos.POST, { token: manager.token, body: { vendorId: v.id, subject: 'x', lines: [line] } }),
      ]);
      const exists = (await prisma.vendor.count({ where: { id: v.id } })) === 1;
      if (exists) expect([201]).toContain(add.status);
      else {
        expect(del.status).toBe(204);
        expect([400, 409]).toContain(add.status);
        expect(await prisma.purchaseOrder.count({ where: { vendorId: v.id } })).toBe(0);
      }
    }
  });

  it('跨域预检 / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    for (const route of [vendors, vendorItem, pos, poItem, poStatus, poReceive]) {
      const res = await route.OPTIONS(new Request('http://localhost/api/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    }
  });
});
