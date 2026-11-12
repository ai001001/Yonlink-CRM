/**
 * 报价单 第一轮：功能测试。
 * Quotes round 1: functional tests.
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
import * as quotes from '@/app/api/quotes/route';
import * as quoteItem from '@/app/api/quotes/[id]/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quoteSync from '@/app/api/quotes/[id]/sync/route';
import { prisma } from '@/server/db';
import { quoteTotals } from '@/server/modules/quotes';
import { Prisma } from '@/generated/prisma/client';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let deal: { id: string };
let product: { id: string };
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '报价客户', phone: '021-55550000', address: '上海市演示路 1 号' } })).json;
  deal = (await call(deals.POST, { token: a.token, body: { name: '报价商机', accountId: acc.id } })).json;
  product = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '增压器', unit: '台', unitPrice: '1000' } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: product.id, quantity: '3', discountPercent: '10' } });
});

const create = (body: object = {}) => call(quotes.POST, { token: a.token, body: { dealId: deal.id, ...body } });
const status = (id: string, s: string) => call(quoteStatus.POST, { token: a.token, params: { id }, body: { status: s } });

describe('quotes R1 create', () => {
  it('由商机生成：复制明细快照、默认主题、编号、税额与总计 / generate from a deal', async () => {
    const res = await create({ taxPercent: '13', validUntil: '2026-12-31', terms: '30% 预付款' });
    expect(res.status).toBe(201);
    const q = res.json;
    expect(q).toMatchObject({
      subject: '报价商机',
      status: 'DRAFT',
      currency: 'CNY',
      subtotal: '2700',
      taxPercent: '13',
      taxAmount: '351',
      total: '3051',
      terms: '30% 预付款',
      createdBy: { id: a.user.id },
      organization: { name: expect.any(String) },
    });
    expect(q.quoteNumber).toMatch(new RegExp(`^QT-${new Date().getUTCFullYear()}-0001$`));
    expect(q.validUntil.slice(0, 10)).toBe('2026-12-31');
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]).toMatchObject({ position: 1, productSku: 'P-1', productName: '增压器', unit: '台', quantity: '3', unitPrice: '1000', discountPercent: '10', lineTotal: '2700' });
    expect(q.deal.account).toMatchObject({ name: '报价客户', phone: '021-55550000', address: '上海市演示路 1 号' });
  });

  it('报价单号按组织连续编号，删除草稿后不复用中间号 / sequential numbers', async () => {
    const n1 = (await create()).json.quoteNumber as string;
    const q2 = (await create()).json;
    const n3 = (await create()).json.quoteNumber as string;
    expect([n1.slice(-4), q2.quoteNumber.slice(-4), n3.slice(-4)]).toEqual(['0001', '0002', '0003']);
    await call(quoteItem.DELETE, { token: a.token, method: 'DELETE', params: { id: q2.id } });
    expect((await create()).json.quoteNumber.slice(-4)).toBe('0004');
  });

  it('税额按十进制四舍五入到分 / tax rounding', () => {
    const r = quoteTotals(new Prisma.Decimal('0.05'), '50');
    expect([r.taxAmount.toString(), r.total.toString()]).toEqual(['0.03', '0.08']);
    const r2 = quoteTotals(new Prisma.Decimal('1234.56'), '6.5');
    expect([r2.taxAmount.toFixed(2), r2.total.toFixed(2)]).toEqual(['80.25', '1314.81']);
  });

  it('快照：之后修改商机明细与产品不影响报价单 / later changes do not affect the quote', async () => {
    const q = (await create()).json;
    const item = (await call(dealItems.GET, { token: a.token, params: { id: deal.id } })).json.items[0];
    await call(itemRoute.PATCH, { token: a.token, method: 'PATCH', params: { id: item.id }, body: { quantity: '9' } });
    await call(productItem.PATCH, { token: a.token, method: 'PATCH', params: { id: product.id }, body: { name: '改名', unit: '件' } });
    const again = (await call(quoteItem.GET, { token: a.token, params: { id: q.id } })).json;
    expect(again.subtotal).toBe('2700');
    expect(again.lines[0]).toMatchObject({ quantity: '3', productName: '增压器', unit: '台' });
  });
});

describe('quotes R1 draft editing', () => {
  it('修改草稿：税率变化重算；审计记录变化字段，条款脱敏 / update a draft', async () => {
    const q = (await create()).json;
    const res = await call(quoteItem.PATCH, { token: a.token, method: 'PATCH', params: { id: q.id }, body: { subject: '新主题', taxPercent: '6', terms: '机密条款', notes: '内部' } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ subject: '新主题', taxPercent: '6', taxAmount: '162', total: '2862' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'quote.update', entityId: q.id } });
    const fields = (log.changes as { fields: Record<string, unknown[]> }).fields;
    expect(fields.subject).toEqual(['报价商机', '新主题']);
    expect(fields.total).toEqual(['2700', '2862']);
    expect(fields.terms).toEqual([null, '[redacted]']);
    expect(JSON.stringify(log.changes)).not.toContain('机密条款');
  });

  it('从商机同步明细：明细与金额更新为商机当前明细 / re-sync from the deal', async () => {
    const q = (await create({ taxPercent: '10' })).json;
    const p2 = (await call(products.POST, { token: a.token, body: { sku: 'P-2', name: '垫片', unitPrice: '5' } })).json;
    await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: p2.id, quantity: '20' } });
    const res = await call(quoteSync.POST, { token: a.token, params: { id: q.id } });
    expect(res.status).toBe(200);
    expect(res.json.lines.map((l: { position: number; productSku: string }) => `${l.position}:${l.productSku}`)).toEqual(['1:P-1', '2:P-2']);
    expect(res.json).toMatchObject({ subtotal: '2800', taxAmount: '280', total: '3080' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'quote.sync_items', entityId: q.id } });
    expect(log.changes).toMatchObject({ lines: [1, 2], fields: { subtotal: ['2700', '2800'] } });
  });

  it('删除草稿：明细一并删除，写审计 / delete a draft', async () => {
    const q = (await create()).json;
    expect((await call(quoteItem.DELETE, { token: a.token, method: 'DELETE', params: { id: q.id } })).status).toBe(204);
    expect(await prisma.quote.count()).toBe(0);
    expect(await prisma.quoteLineItem.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'quote.delete', entityId: q.id } })).toBe(1);
  });
});

describe('quotes R1 status', () => {
  it('草稿 → 已发送 → 已接受，记录发送与答复时间及审计 / draft → sent → accepted', async () => {
    const q = (await create()).json;
    const sent = await status(q.id, 'SENT');
    expect(sent.status).toBe(200);
    expect(sent.json.status).toBe('SENT');
    expect(sent.json.sentAt).not.toBeNull();
    const accepted = (await status(q.id, 'ACCEPTED')).json;
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.decidedAt).not.toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { action: 'quote.status', entityId: q.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => (l.changes as { fields: { status: string[] } }).fields.status)).toEqual([
      ['DRAFT', 'SENT'],
      ['SENT', 'ACCEPTED'],
    ]);
  });

  it('已发送可退回草稿（清除发送时间）后再修改；也可标记为已拒绝 / sent → draft, sent → rejected', async () => {
    const q = (await create()).json;
    await status(q.id, 'SENT');
    const back = (await status(q.id, 'DRAFT')).json;
    expect(back).toMatchObject({ status: 'DRAFT', sentAt: null });
    expect((await call(quoteItem.PATCH, { token: a.token, method: 'PATCH', params: { id: q.id }, body: { subject: '修订版' } })).status).toBe(200);
    await status(q.id, 'SENT');
    expect((await status(q.id, 'REJECTED')).json.status).toBe('REJECTED');
  });

  it('列表：按状态、商机筛选，按编号/主题/客户搜索 / list filters and search', async () => {
    const q1 = (await create({ subject: '首版' })).json;
    await create({ subject: '第二版' });
    await status(q1.id, 'SENT');
    const list = (query: Record<string, string>) => call(quotes.GET, { token: a.token, query });
    expect((await list({})).json.total).toBe(2);
    expect((await list({ status: 'SENT' })).json.items.map((x: { subject: string }) => x.subject)).toEqual(['首版']);
    expect((await list({ dealId: deal.id })).json.total).toBe(2);
    expect((await list({ q: q1.quoteNumber })).json.total).toBe(1);
    expect((await list({ q: '第二' })).json.total).toBe(1);
    expect((await list({ q: '报价客户' })).json.total).toBe(2);
    expect((await list({ q: '100%' })).json.total).toBe(0);
    expect((await list({})).json.items[0]).toMatchObject({ deal: { name: '报价商机', account: { name: '报价客户' } }, createdBy: { id: a.user.id } });
  });

  it('删除商机时其报价单随之删除 / quotes cascade with the deal', async () => {
    await create();
    await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: deal.id } });
    expect(await prisma.quote.count()).toBe(0);
    expect(await prisma.quoteLineItem.count()).toBe(0);
  });
});

describe('quotes R1 demo data', () => {
  it('演示报价单：明细 = 商机明细，金额一致，编号按创建时间递增 / demo quotes are consistent', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const data = buildDemoData();
    const list = await prisma.quote.findMany({ where: { organizationId: org.id }, include: { lines: true, deal: { include: { lineItems: true } } }, orderBy: { quoteNumber: 'asc' } });
    expect(list).toHaveLength(data.quotes.length);
    expect(new Set(list.map((q) => q.status))).toEqual(new Set(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED']));
    for (const q of list) {
      const sum = q.lines.reduce((s, l) => s.plus(l.lineTotal), new Prisma.Decimal(0));
      expect(sum.equals(q.subtotal)).toBe(true);
      expect(q.subtotal.equals(q.deal.amount)).toBe(true);
      expect(q.lines).toHaveLength(q.deal.lineItems.length);
      const t = quoteTotals(q.subtotal, q.taxPercent);
      expect(t.taxAmount.equals(q.taxAmount) && t.total.equals(q.total)).toBe(true);
      expect(q.currency).toBe(q.deal.currency);
    }
    const created = list.map((q) => q.createdAt.getTime());
    expect(created).toEqual([...created].sort((x, y) => x - y));
  });
});
