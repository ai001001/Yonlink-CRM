/**
 * 商机阶段历史 第一轮：功能测试（新建写入一行；阶段、金额、币种、预计成交日变化各写一行，其他字段不写；修改人；
 * 停留时长、可能性、预期收入、当前标记、阶段是否变化；赢单后不计时长；产品明细改金额、批量改阶段、线索转化记录修改人；
 * 回收站恢复保留原历史；接口可见范围与 404；阶段停留时长报表（已结束停留、目前处于、成交周期、时间段、负责人筛选））。
 * Deal stage history round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as stageHistory from '@/app/api/deals/[id]/stage-history/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as deals from '@/app/api/deals/route';
import * as leadConvert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import * as products from '@/app/api/products/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import * as stageDuration from '@/app/api/reports/stage-duration/route';
import { prisma } from '@/server/db';
import { stageDurationReport } from '@/server/modules/deal-stage-history';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let acc: { id: string };

const newDeal = async (body: object = {}, token = a.token) => (await call(deals.POST, { token, body: { name: '商机', accountId: acc.id, amount: '1000', ...body } })).json;
const patch = (id: string, body: object, token = a.token) => call(dealItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const history = (id: string, token = a.token) => call(stageHistory.GET, { token, params: { id } });
/** 把某商机的历史整体前移若干天（模拟时间流逝）/ shift a deal's history back by some days (simulate elapsed time) */
async function age(dealId: string, rows: { stage: string; daysAgo: number }[]) {
  await prisma.dealStageHistory.deleteMany({ where: { dealId } });
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  await prisma.dealStageHistory.createMany({
    data: rows.map((r) => ({ organizationId: deal.organizationId, dealId, stage: r.stage as never, amount: deal.amount, currency: deal.currency, changedAt: new Date(Date.now() - r.daysAgo * 86_400_000) })),
  });
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
});

describe('stage history R1 recording', () => {
  it('新建与各字段变化各写一行，其他字段不写；修改人；时长与可能性 / rows per tracked change', async () => {
    const deal = await newDeal({ expectedCloseDate: '2026-12-31' });
    let r = await history(deal.id);
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ stage: 'QUALIFICATION', amount: '1000', currency: 'CNY', expectedCloseDate: '2026-12-31', changedBy: { id: a.user.id }, stageChanged: true, current: true, probability: 10, expectedRevenue: '100.00' });
    expect(r.json.items[0].durationMs).toBeGreaterThanOrEqual(0);

    // 不跟踪的字段不写 / untracked fields write nothing
    await patch(deal.id, { name: '改名', description: '说明' });
    expect((await history(deal.id)).json.items).toHaveLength(1);
    // 相同值不写 / the same value writes nothing
    await patch(deal.id, { stage: 'QUALIFICATION', amount: '1000.00' });
    expect((await history(deal.id)).json.items).toHaveLength(1);

    await patch(deal.id, { stage: 'PROPOSAL' });
    await patch(deal.id, { amount: '2500.50' });
    await patch(deal.id, { currency: 'USD' });
    await patch(deal.id, { expectedCloseDate: null });
    r = await history(deal.id);
    const items = r.json.items as { stage: string; amount: string; currency: string; expectedCloseDate: string | null; stageChanged: boolean; current: boolean; probability: number; expectedRevenue: string; durationMs: number }[];
    expect(items.map((i) => [i.stage, i.amount, i.currency, i.expectedCloseDate, i.stageChanged, i.current])).toEqual([
      ['PROPOSAL', '2500.5', 'USD', null, false, true],
      ['PROPOSAL', '2500.5', 'USD', '2026-12-31', false, false],
      ['PROPOSAL', '2500.5', 'CNY', '2026-12-31', false, false],
      ['PROPOSAL', '1000', 'CNY', '2026-12-31', true, false],
      ['QUALIFICATION', '1000', 'CNY', '2026-12-31', true, false],
    ]);
    expect(items[0]).toMatchObject({ probability: 40, expectedRevenue: '1000.20' });
    // 销售代表改自己的商机：修改人为销售代表 / a rep editing their own deal is the actor
    const own = await newDeal({ ownerId: rep.user.id });
    await patch(own.id, { stage: 'NEGOTIATION' }, rep.token);
    expect((await history(own.id, rep.token)).json.items[0]).toMatchObject({ stage: 'NEGOTIATION', changedBy: { id: rep.user.id }, probability: 70 });
  });

  it('停留时长：到下一条为止，当前阶段计到现在，赢单输单不计 / durations', async () => {
    const deal = await newDeal();
    await age(deal.id, [
      { stage: 'QUALIFICATION', daysAgo: 10 },
      { stage: 'PROPOSAL', daysAgo: 4 },
    ]);
    let items = (await history(deal.id)).json.items;
    expect(Math.round(items[1].durationMs / 86_400_000)).toBe(6);
    expect(Math.round(items[0].durationMs / 86_400_000)).toBe(4);
    await patch(deal.id, { stage: 'CLOSED_WON' });
    items = (await history(deal.id)).json.items;
    expect(items[0]).toMatchObject({ stage: 'CLOSED_WON', current: true, durationMs: null, probability: 100 });
    expect(Math.round(items[1].durationMs / 86_400_000)).toBe(4);
    await patch(deal.id, { stage: 'CLOSED_LOST' });
    expect((await history(deal.id)).json.items[0]).toMatchObject({ stage: 'CLOSED_LOST', durationMs: null, probability: 0, expectedRevenue: '0.00' });
  });

  it('产品明细改金额、批量改阶段、线索转化均记录修改人 / other write paths', async () => {
    const deal = await newDeal({ amount: '0' });
    const p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品', unitPrice: '300' } })).json;
    expect((await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: p.id, quantity: '2' } })).status).toBe(201);
    expect((await history(deal.id)).json.items[0]).toMatchObject({ amount: '600', changedBy: { id: a.user.id } });
    const bulk = await call(dealBulk.POST, { token: a.token, body: { action: 'stage', ids: [deal.id], stage: 'NEEDS_ANALYSIS' } });
    expect(bulk.json.succeeded).toEqual([deal.id]);
    expect((await history(deal.id)).json.items[0]).toMatchObject({ stage: 'NEEDS_ANALYSIS', changedBy: { id: a.user.id } });

    const lead = (await call(leads.POST, { token: a.token, body: { name: '线索', company: '新公司' } })).json;
    const conv = await call(leadConvert.POST, { token: a.token, params: { id: lead.id }, body: { account: { mode: 'new' }, deal: { name: '转化商机', amount: '800', stage: 'PROPOSAL' } } });
    expect(conv.status).toBe(200);
    const converted = await prisma.deal.findFirstOrThrow({ where: { name: '转化商机' } });
    expect((await history(converted.id)).json.items).toMatchObject([{ stage: 'PROPOSAL', amount: '800', changedBy: { id: a.user.id } }]);
  });

  it('回收站：删除后恢复保留原历史（不重复新建行）/ restore keeps the history', async () => {
    const deal = await newDeal();
    await patch(deal.id, { stage: 'PROPOSAL' });
    await patch(deal.id, { stage: 'NEGOTIATION' });
    const before = (await history(deal.id)).json.items.map((i: { id: string; stage: string; changedAt: string }) => [i.id, i.stage, i.changedAt]);
    expect((await call(dealItem.DELETE, { token: a.token, params: { id: deal.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.dealStageHistory.count({ where: { dealId: deal.id } })).toBe(0);
    const item = (await call(bin.GET, { token: a.token, query: { entityType: 'deal' } })).json.items[0];
    expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    const after = (await history(deal.id)).json.items.map((i: { id: string; stage: string; changedAt: string }) => [i.id, i.stage, i.changedAt]);
    expect(after).toEqual(before);
  });

  it('可见范围：销售代表看不到别人的商机历史；他组织 404；不存在 404 / visibility', async () => {
    const deal = await newDeal();
    expect((await history(deal.id, rep.token)).status).toBe(404);
    const viewer = await addUser(a.org.id, 'READONLY', '只读');
    expect((await history(deal.id, viewer.token)).status).toBe(200);
    const b = await createTenant('B');
    expect((await history(deal.id, b.token)).status).toBe(404);
    expect((await history('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await history('bad')).status).toBe(404);
  });
});

describe('stage history R1 duration report', () => {
  it('已结束停留平均天数、目前处于、成交周期、时间段、负责人筛选与可见范围 / stage duration report', async () => {
    const d1 = await newDeal();
    const d2 = await newDeal({ ownerId: rep.user.id });
    const d3 = await newDeal();
    const d4 = await newDeal();
    await age(d1.id, [
      { stage: 'QUALIFICATION', daysAgo: 30 },
      { stage: 'QUALIFICATION', daysAgo: 25 }, // 金额变化等，同一阶段合并 / same stage merges
      { stage: 'NEEDS_ANALYSIS', daysAgo: 20 },
      { stage: 'NEGOTIATION', daysAgo: 10 },
      { stage: 'CLOSED_WON', daysAgo: 4 },
    ]);
    await age(d2.id, [
      { stage: 'QUALIFICATION', daysAgo: 12 },
      { stage: 'NEEDS_ANALYSIS', daysAgo: 6 },
    ]);
    await age(d3.id, [
      { stage: 'QUALIFICATION', daysAgo: 9 },
      { stage: 'CLOSED_LOST', daysAgo: 1 },
    ]);
    // 时间段之外开始的停留不计入已结束 / stays started before the period are not counted as completed
    await age(d4.id, [
      { stage: 'QUALIFICATION', daysAgo: 400 },
      { stage: 'PROPOSAL', daysAgo: 380 },
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const r = await call(stageDuration.GET, { token: a.token, query: { from, to: today } });
    expect(r.status).toBe(200);
    const s = Object.fromEntries(r.json.stages.map((x: { stage: string }) => [x.stage, x]));
    // 资格确认：d1 10 天、d2 6 天、d3 8 天 → 平均 8 / qualification: 10, 6, 8 → 8
    expect(s.QUALIFICATION.completed).toEqual({ count: 3, avgDays: 8 });
    expect(s.NEEDS_ANALYSIS.completed).toEqual({ count: 1, avgDays: 10 });
    expect(s.NEGOTIATION.completed).toEqual({ count: 1, avgDays: 6 });
    expect(s.PROPOSAL.completed).toEqual({ count: 0, avgDays: null });
    // 目前处于：d2 需求分析 6 天、d4 方案报价 380 天（不受时间段影响）/ current stays ignore the period
    expect(s.NEEDS_ANALYSIS.current).toEqual({ count: 1, avgDays: 6 });
    expect(s.PROPOSAL.current).toEqual({ count: 1, avgDays: 380 });
    expect(s.QUALIFICATION.current).toEqual({ count: 0, avgDays: null });
    expect(r.json.cycle).toEqual({ won: { count: 1, avgDays: 26 }, lost: { count: 1, avgDays: 8 } });
    // 负责人筛选与销售代表可见范围 / owner filter and the rep's visibility
    const byRep = (await call(stageDuration.GET, { token: a.token, query: { from, to: today, ownerId: rep.user.id } })).json;
    expect(byRep.stages.find((x: { stage: string }) => x.stage === 'QUALIFICATION').completed).toEqual({ count: 1, avgDays: 6 });
    const mine = (await call(stageDuration.GET, { token: rep.token, query: { from, to: today } })).json;
    expect(mine.cycle.won.count).toBe(0);
    expect(mine.stages.find((x: { stage: string }) => x.stage === 'NEEDS_ANALYSIS').current.count).toBe(1);
    // 销售代表筛选别人：空结果 / a rep filtering by someone else gets nothing
    const other = (await call(stageDuration.GET, { token: rep.token, query: { from, to: today, ownerId: a.user.id } })).json;
    expect(other.stages.every((x: { completed: { count: number }; current: { count: number } }) => x.completed.count === 0 && x.current.count === 0)).toBe(true);
    // 参数校验 / validation
    expect((await call(stageDuration.GET, { token: a.token, query: { from: today, to: from } })).status).toBe(400);
    expect((await call(stageDuration.GET, { token: a.token, query: { currency: 'CNY' } })).status).toBe(400);
    // 默认时间段（最近 12 个月）/ the default period
    const def = await stageDurationReport({ ...a, organizationId: a.org.id, userId: a.user.id, role: 'ADMIN' } as never, {});
    expect(def.stages).toHaveLength(4);
  });
});
