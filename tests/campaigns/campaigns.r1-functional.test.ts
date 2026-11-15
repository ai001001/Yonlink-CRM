/**
 * 市场活动 第一轮：功能测试（新建、修改、名称唯一、日期校验、删除限制与审计；线索与商机关联、列表筛选、
 * 线索转化继承活动；统计：线索、转化、商机、在手与赢单折合人民币、投入产出比与缺少汇率；回收站恢复；演示数据）。
 * Campaigns round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_CAMPAIGNS, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as campaignItem from '@/app/api/campaigns/[id]/route';
import * as campaignOptions from '@/app/api/campaigns/options/route';
import * as campaigns from '@/app/api/campaigns/route';
import * as deals from '@/app/api/deals/route';
import * as rates from '@/app/api/exchange-rates/route';
import * as leadConvert from '@/app/api/leads/[id]/convert/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const create = (body: object) => call(campaigns.POST, { token: a.token, body: { type: 'EXHIBITION', ...body } });
const detail = async (id: string) => (await call(campaignItem.GET, { token: a.token, params: { id } })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('campaigns R1 manage', () => {
  it('新建、修改、名称唯一、日期校验、审计 / create, update, rules, audit', async () => {
    const r = await create({ name: '春季展会', startDate: '2026-03-01', endDate: '2026-03-03', budget: '10000', actualCost: '8000' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '春季展会', status: 'PLANNED', currency: 'CNY', budget: '10000', actualCost: '8000', owner: { id: a.user.id } });
    expect(r.json.stats).toMatchObject({ leads: 0, deals: 0, wonAmount: '0.00', costInBase: '8000.00', roi: -100 });
    const dup = await create({ name: '春季展会' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details).toEqual({ name: ['taken'] });
    expect((await create({ name: '日期颠倒', startDate: '2026-03-05', endDate: '2026-03-01' })).json.error.details).toEqual({ endDate: ['before_start'] });
    const up = await call(campaignItem.PATCH, { token: a.token, params: { id: r.json.id }, body: { status: 'ACTIVE', endDate: '2026-03-10' }, method: 'PATCH' });
    expect(up.json).toMatchObject({ status: 'ACTIVE' });
    expect((await call(campaignItem.PATCH, { token: a.token, params: { id: r.json.id }, body: { endDate: '2026-02-01' }, method: 'PATCH' })).status).toBe(400);
    const logs = await prisma.auditLog.findMany({ where: { entityId: r.json.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['campaign.create', 'campaign.update']);
    expect(logs[1]!.changes).toMatchObject({ fields: { status: ['PLANNED', 'ACTIVE'] } });
  });

  it('列表搜索与筛选；选项不含已取消（除非是当前值）/ list and options', async () => {
    const c1 = (await create({ name: '展会甲', status: 'ACTIVE' })).json;
    const c2 = (await create({ name: '广告乙', type: 'ADVERTISEMENT', status: 'CANCELLED', description: '线上投放' })).json;
    const names = async (query: Record<string, string>) => (await call(campaigns.GET, { token: a.token, query })).json.items.map((x: { name: string }) => x.name).sort();
    expect(await names({})).toEqual(['展会甲', '广告乙'].sort());
    expect(await names({ q: '投放' })).toEqual(['广告乙']);
    expect(await names({ type: 'EXHIBITION' })).toEqual(['展会甲']);
    expect(await names({ status: 'CANCELLED' })).toEqual(['广告乙']);
    expect((await call(campaignOptions.GET, { token: a.token })).json.items.map((x: { id: string }) => x.id)).toEqual([c1.id]);
    expect((await call(campaignOptions.GET, { token: a.token, query: { include: c2.id } })).json.items.map((x: { id: string }) => x.id).sort()).toEqual([c1.id, c2.id].sort());
  });

  it('有关联记录不能删除；无关联可删除并审计 / delete rules', async () => {
    const c = (await create({ name: '可删活动' })).json;
    const used = (await create({ name: '已用活动' })).json;
    await call(leads.POST, { token: a.token, body: { name: '线索', campaignId: used.id } });
    const r = await call(campaignItem.DELETE, { token: a.token, params: { id: used.id }, method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ campaign: ['leads:1', 'deals:0'] });
    expect((await call(campaignItem.DELETE, { token: a.token, params: { id: c.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.auditLog.count({ where: { action: 'campaign.delete', entityId: c.id } })).toBe(1);
  });
});

describe('campaigns R1 links & stats', () => {
  it('线索、商机关联与筛选；转化继承；统计与投入产出 / links, conversion, statistics', async () => {
    await call(rates.PUT, { token: a.token, body: { currency: 'USD', rate: '7', effectiveDate: '2026-01-01' }, method: 'PUT' });
    const c = (await create({ name: '展会', currency: 'USD', actualCost: '100' })).json;
    const l1 = (await call(leads.POST, { token: a.token, body: { name: '线索一', company: '甲公司', campaignId: c.id } })).json;
    await call(leads.POST, { token: a.token, body: { name: '线索二', campaignId: c.id } });
    await call(leads.POST, { token: a.token, body: { name: '无活动线索' } });
    expect(l1.campaign).toEqual({ id: c.id, name: '展会' });
    expect((await call(leads.GET, { token: a.token, query: { campaignId: c.id } })).json.total).toBe(2);
    // 转化：商机继承活动 / conversion: the deal inherits the campaign
    const conv = await call(leadConvert.POST, { token: a.token, params: { id: l1.id }, body: { account: { mode: 'new' }, deal: { name: '展会商机', amount: '1000', stage: 'CLOSED_WON' } } });
    expect(conv.status).toBe(200);
    const deal = await prisma.deal.findFirstOrThrow({ where: { name: '展会商机' } });
    expect(deal.campaignId).toBe(c.id);
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '乙公司' } })).json;
    await call(deals.POST, { token: a.token, body: { name: '美元在手', accountId: acc.id, amount: '50', currency: 'USD', stage: 'PROPOSAL', campaignId: c.id } });
    await call(deals.POST, { token: a.token, body: { name: '欧元赢单', accountId: acc.id, amount: '10', currency: 'EUR', stage: 'CLOSED_WON', campaignId: c.id } });
    expect((await call(deals.GET, { token: a.token, query: { campaignId: c.id } })).json.total).toBe(3);
    const d = await detail(c.id);
    // 花费 100 USD = 700 CNY；赢单 1000 CNY（欧元缺汇率不计）；投入产出 (1000 − 700) ÷ 700 = 42.9%
    expect(d.stats).toEqual({
      leads: 2,
      convertedLeads: 1,
      conversionRate: 50,
      deals: 3,
      wonDeals: 2,
      openAmount: '350.00',
      wonAmount: '1000.00',
      costInBase: '700.00',
      roi: 42.9,
      baseCurrency: 'CNY',
      missing: ['EUR'],
    });
    expect(d.leads.map((x: { name: string }) => x.name).sort()).toEqual(['线索一', '线索二']);
    expect(d.deals).toHaveLength(3);
  });

  it('关联不存在或他组织的活动 400；改线索的活动写审计；可清除关联 / link validation and audit', async () => {
    const other = await createTenant('B');
    const theirs = (await call(campaigns.POST, { token: other.token, body: { name: '乙组织活动', type: 'EMAIL' } })).json;
    const r = await call(leads.POST, { token: a.token, body: { name: 'x', campaignId: theirs.id } });
    expect(r.status).toBe(400);
    expect(r.json.error.details).toEqual({ campaignId: ['not_found'] });
    const c = (await create({ name: '本组织活动' })).json;
    const l = (await call(leads.POST, { token: a.token, body: { name: '线索' } })).json;
    await call(leadItem.PATCH, { token: a.token, params: { id: l.id }, body: { campaignId: c.id }, method: 'PATCH' });
    const cleared = await call(leadItem.PATCH, { token: a.token, params: { id: l.id }, body: { campaignId: null }, method: 'PATCH' });
    expect(cleared.json.campaignId).toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { entityId: l.id, action: 'lead.update' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((x) => x.changes)).toEqual([{ fields: { campaignId: [null, c.id] } }, { fields: { campaignId: [c.id, null] } }]);
  });

  it('回收站恢复：活动已删除时清空关联并提示 / restore clears a vanished campaign', async () => {
    const c = (await create({ name: '临时活动' })).json;
    const l = (await call(leads.POST, { token: a.token, body: { name: '临时线索', campaignId: c.id } })).json;
    await call(leadItem.DELETE, { token: a.token, params: { id: l.id }, method: 'DELETE' });
    expect((await call(campaignItem.DELETE, { token: a.token, params: { id: c.id }, method: 'DELETE' })).status).toBe(204);
    const item = await prisma.recycleBinItem.findFirstOrThrow({ where: { entityId: l.id } });
    const r = await call(restore.POST, { token: a.token, params: { id: item.id } });
    expect(r.status).toBe(200);
    expect(r.json.skipped).toContain('campaign');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).campaignId).toBeNull();
  });
});

describe('campaigns R1 demo', () => {
  it('演示活动与关联 / demo campaigns', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.campaign.findMany({ where: { organizationId: org.id }, include: { _count: { select: { leads: true, deals: true } } } });
    expect(rows.map((r) => r.name).sort()).toEqual(DEMO_CAMPAIGNS.map((c) => c.name).sort());
    const expo = rows.find((r) => r.name.includes('汽配展'))!;
    expect(expo._count.leads).toBeGreaterThan(0);
    expect(expo._count.deals).toBeGreaterThan(0);
    // 关联的商机都来自同一活动的已转化线索 / linked deals come from the campaign's converted leads
    const deals = await prisma.deal.findMany({ where: { campaignId: expo.id }, select: { id: true } });
    for (const d of deals) expect(await prisma.lead.count({ where: { convertedDealId: d.id, campaignId: expo.id } })).toBe(1);
    expect(rows.find((r) => r.status === 'PLANNED')!._count).toEqual({ leads: 0, deals: 0 });
  });
});
