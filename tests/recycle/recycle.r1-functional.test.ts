/**
 * 回收站 第一轮：功能测试（删除进入回收站与快照、原样恢复附属数据、共享跟进与转化关联、报价单号保留、
 * 依赖缺失时拒绝恢复、批量删除、彻底删除与清空、过期清除）。
 * Recycle bin round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leadConvert from '@/app/api/leads/[id]/convert/route';
import * as leadTags from '@/app/api/leads/[id]/tags/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as notes from '@/app/api/notes/route';
import * as productItem from '@/app/api/products/[id]/route';
import * as products from '@/app/api/products/route';
import * as quotes from '@/app/api/quotes/route';
import * as binItem from '@/app/api/recycle-bin/[id]/route';
import * as restoreRoute from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import * as tags from '@/app/api/tags/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const post = async (route: { POST: never } | { POST: unknown }, body: object, params?: Record<string, string>) =>
  (await call((route as { POST: Parameters<typeof call>[0] }).POST, { token: a.token, body, params })).json;
const del = (route: { DELETE: Parameters<typeof call>[0] }, id: string) => call(route.DELETE, { token: a.token, method: 'DELETE', params: { id } });
const list = async (query: Record<string, string> = {}) => (await call(bin.GET, { token: a.token, query })).json;
const restore = (id: string) => call(restoreRoute.POST, { token: a.token, params: { id } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('recycle R1 leads', () => {
  it('删除线索进入回收站：快照摘要，原记录与附属数据不在系统中 / delete moves to the bin', async () => {
    const lead = await post(leads, { name: '回收线索', company: '演示公司' });
    const acc = await post(accounts, { name: '共享客户' });
    const tag = await post(tags, { name: '标签甲' });
    await call(leadTags.PUT, { token: a.token, method: 'PUT', params: { id: lead.id }, body: { tagIds: [tag.id] } });
    await post(notes, { leadId: lead.id, content: '线索备注' });
    await post(activities, { type: 'CALL', subject: '仅线索', leadId: lead.id });
    const shared = await post(activities, { type: 'CALL', subject: '共享跟进', leadId: lead.id, accountId: acc.id });
    expect((await del(leadItem, lead.id)).status).toBe(204);
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.note.count()).toBe(0);
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: shared.id } })).toMatchObject({ leadId: null, accountId: acc.id });
    const r = await list();
    expect(r.retentionDays).toBe(30);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ entityType: 'lead', entityId: lead.id, displayName: '回收线索（演示公司）', summary: { notes: 1, activities: 2, tags: 1 }, deletedBy: { id: a.user.id } });
    const days = (new Date(r.items[0].expiresAt).getTime() - new Date(r.items[0].deletedAt).getTime()) / 86_400_000;
    expect(days).toBe(30);
    expect(await prisma.auditLog.count({ where: { action: 'lead.delete', entityId: lead.id } })).toBe(1);
  });

  it('恢复线索：原 ID 与时间、备注、跟进、标签、共享跟进重新关联，条目移除并审计 / restore everything', async () => {
    const lead = await post(leads, { name: '恢复线索' });
    const acc = await post(accounts, { name: '共享客户' });
    const tag = await post(tags, { name: '标签甲' });
    await call(leadTags.PUT, { token: a.token, method: 'PUT', params: { id: lead.id }, body: { tagIds: [tag.id] } });
    const note = await post(notes, { leadId: lead.id, content: '线索备注' });
    const own = await post(activities, { type: 'TASK', subject: '仅线索', leadId: lead.id, completed: true });
    const shared = await post(activities, { type: 'CALL', subject: '共享跟进', leadId: lead.id, accountId: acc.id });
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    await del(leadItem, lead.id);
    const item = (await list()).items[0];
    const res = await restore(item.id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ entityType: 'lead', entityId: lead.id, skipped: [] });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect(after.name).toBe('恢复线索');
    expect(await prisma.note.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ leadId: lead.id, content: '线索备注' });
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ leadId: lead.id, completed: true });
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: shared.id } })).toMatchObject({ leadId: lead.id, accountId: acc.id });
    expect(await prisma.leadTag.count({ where: { leadId: lead.id } })).toBe(1);
    expect((await list()).items).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: 'lead.restore', entityId: lead.id } })).toBe(1);
    expect((await call(leads.GET, { token: a.token })).json.total).toBe(1);
  });

  it('恢复时已不存在的标签与转化商机被跳过并说明 / vanished links are skipped and reported', async () => {
    const lead = await post(leads, { name: '已转化线索', company: '甲公司' });
    const conv = await post(leadConvert, { account: { mode: 'new' }, deal: { name: '转化商机' } }, { id: lead.id });
    const tag = await post(tags, { name: '临时' });
    await call(leadTags.PUT, { token: a.token, method: 'PUT', params: { id: lead.id }, body: { tagIds: [tag.id] } });
    await del(leadItem, lead.id);
    await del(dealItem, conv.deal.id);
    await prisma.tag.delete({ where: { id: tag.id } });
    const item = (await list({ entityType: 'lead' })).items[0];
    const res = await restore(item.id);
    expect(res.json.skipped.sort()).toEqual(['convertedDeal', 'tags']);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: 'CONVERTED', convertedDealId: null, convertedAccountId: conv.account.id });
  });
});

describe('recycle R1 accounts & deals', () => {
  it('恢复客户：联系人与转化来源线索重新关联 / account restore relinks contacts and conversions', async () => {
    const lead = await post(leads, { name: '来源线索', company: '乙公司' });
    const conv = await post(leadConvert, { account: { mode: 'new' } }, { id: lead.id });
    const accountId = conv.account.id as string;
    expect((await del(accountItem, accountId)).status).toBe(204);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ convertedAccountId: null, convertedContactId: null });
    const item = (await list({ entityType: 'account' })).items[0];
    expect(item.summary.contacts).toBe(1);
    expect((await restore(item.id)).json.skipped).toEqual([]);
    const restored = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(restored).toMatchObject({ convertedAccountId: accountId, convertedContactId: conv.contact.id });
    expect(await prisma.contact.count({ where: { accountId } })).toBe(1);
  });

  it('恢复商机：产品明细、报价单（含明细与原编号）、金额；回收期间报价单号不被复用 / deal restore with items and quotes', async () => {
    const acc = await post(accounts, { name: '客户' });
    const deal = await post(deals, { name: '大商机', accountId: acc.id });
    const product = await post(products, { sku: 'P-1', name: '产品', unitPrice: '100' });
    await post(dealItems, { productId: product.id, quantity: '3' }, { id: deal.id });
    const q = await post(quotes, { dealId: deal.id, taxPercent: '13' });
    await del(dealItem, deal.id);
    expect(await prisma.quote.count()).toBe(0);
    const other = await post(deals, { name: '新商机', accountId: acc.id });
    await post(dealItems, { productId: product.id, quantity: '1' }, { id: other.id });
    const q2 = await post(quotes, { dealId: other.id });
    expect(q2.quoteNumber).not.toBe(q.quoteNumber);
    expect(q2.quoteNumber.slice(-4)).toBe('0002');
    const item = (await list({ entityType: 'deal' })).items[0];
    expect(item.summary).toMatchObject({ lineItems: 1, quotes: 1 });
    expect((await restore(item.id)).status).toBe(200);
    const d = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id }, include: { lineItems: true, quotes: { include: { lines: true } } } });
    expect(d.amount.toString()).toBe('300');
    expect(d.lineItems).toHaveLength(1);
    expect(d.quotes[0]).toMatchObject({ quoteNumber: q.quoteNumber, total: expect.anything() });
    expect(d.quotes[0]!.total.toString()).toBe('339');
    expect(d.quotes[0]!.lines).toHaveLength(1);
  });

  it('依赖缺失时拒绝恢复且条目保留：客户已删 / 产品已删 / missing parents block the restore', async () => {
    const acc = await post(accounts, { name: '将删客户' });
    const deal = await post(deals, { name: '依赖商机', accountId: acc.id });
    const product = await post(products, { sku: 'P-9', name: '将删产品', unitPrice: '1' });
    await post(dealItems, { productId: product.id, quantity: '1' }, { id: deal.id });
    await del(dealItem, deal.id);
    await del(accountItem, acc.id);
    const dealEntry = (await list({ entityType: 'deal' })).items[0];
    const r1 = await restore(dealEntry.id);
    expect(r1.status).toBe(409);
    expect(r1.json.error.details).toEqual({ account: ['missing'] });
    expect((await list()).items).toHaveLength(2);
    await restore((await list({ entityType: 'account' })).items[0].id);
    await del(productItem, product.id);
    const r2 = await restore(dealEntry.id);
    expect(r2.status).toBe(409);
    expect(r2.json.error.details).toEqual({ products: ['missing'] });
    expect(await prisma.deal.count()).toBe(0);
  });

  it('批量删除进入回收站；按类型与名称筛选 / bulk delete and filters', async () => {
    const acc = await post(accounts, { name: '客户' });
    const ids = [(await post(deals, { name: '批量一', accountId: acc.id })).id, (await post(deals, { name: '批量二', accountId: acc.id })).id];
    const r = await call(dealBulk.POST, { token: a.token, body: { action: 'delete', ids } });
    expect(r.json.succeeded).toHaveLength(2);
    expect((await list({ entityType: 'deal' })).items).toHaveLength(2);
    expect((await list({ entityType: 'lead' })).items).toHaveLength(0);
    expect((await list({ q: '批量二' })).items.map((i: { displayName: string }) => i.displayName)).toEqual(['批量二']);
  });
});

describe('recycle R1 purge & expiry', () => {
  it('彻底删除单条与清空，均写审计 / purge and empty', async () => {
    for (const n of ['一', '二', '三']) await del(leadItem, (await post(leads, { name: `线索${n}` })).id);
    const items = (await list()).items;
    expect((await call(binItem.DELETE, { token: a.token, method: 'DELETE', params: { id: items[0].id } })).status).toBe(204);
    expect(await prisma.auditLog.count({ where: { action: 'lead.purge' } })).toBe(1);
    const emptied = await call(bin.DELETE, { token: a.token, method: 'DELETE' });
    expect(emptied.json).toEqual({ purged: 2 });
    expect(await prisma.auditLog.count({ where: { action: 'lead.purge' } })).toBe(3);
    expect((await list()).items).toHaveLength(0);
  });

  it('过期条目：访问时清除并审计，不能再恢复 / expired entries are removed', async () => {
    const lead = await post(leads, { name: '过期线索' });
    await del(leadItem, lead.id);
    const item = await prisma.recycleBinItem.findFirstOrThrow();
    await prisma.recycleBinItem.update({ where: { id: item.id }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000), expiresAt: new Date(Date.now() - 1000) } });
    expect((await restore(item.id)).status).toBe(404);
    expect((await list()).items).toHaveLength(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.expire' } });
    expect(log).toMatchObject({ actorId: null, entityId: lead.id, changes: { name: '过期线索' } });
  });
});
