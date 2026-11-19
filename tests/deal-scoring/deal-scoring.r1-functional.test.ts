/**
 * 商机评分 第一轮：功能测试（商机规则接口与校验、金额阈值规范化与审计；阶段、预计成交日、描述；金额阈值按人民币、外币按汇率
 * 折算、缺汇率不计、录入/修改/删除汇率自动重算；产品明细、联系人角色与决策人、报价单、竞争对手减分、已完成跟进；得分明细与
 * 分级；列表按评分排序与按分级筛选、看板带评分、导出按分级筛选；回收站恢复商机；演示数据）。
 * Deal scoring round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_DEAL_SCORING, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as competitorItem from '@/app/api/deal-competitors/[id]/route';
import * as dealItemsRoute from '@/app/api/deal-items/[id]/route';
import * as board from '@/app/api/deals/board/route';
import * as competitors from '@/app/api/deals/[id]/competitors/route';
import * as dealRoles from '@/app/api/deals/[id]/contact-roles/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as dealScore from '@/app/api/deals/[id]/score/route';
import * as dealExport from '@/app/api/deals/export/route';
import * as deals from '@/app/api/deals/route';
import * as rateItem from '@/app/api/exchange-rates/[id]/route';
import * as rates from '@/app/api/exchange-rates/route';
import * as products from '@/app/api/products/route';
import * as quotes from '@/app/api/quotes/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import * as scoring from '@/app/api/scoring/[entity]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
const today = new Date().toISOString().slice(0, 10);
const save = (rules: object[], extra: object = {}, entity = 'deal') => call(scoring.PUT, { token: a.token, params: { entity }, body: { hotScore: 40, warmScore: 20, rules, ...extra }, method: 'PUT' });
const newDeal = async (body: object) => {
  const r = await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, ...body } });
  expect(r.status).toBe(201);
  return r.json;
};
const scoreOf = async (id: string) => (await prisma.deal.findUniqueOrThrow({ where: { id } })).score;
const setRate = (currency: string, rate: string, effectiveDate = today) => call(rates.PUT, { token: a.token, body: { currency, rate, effectiveDate }, method: 'PUT' });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
});

describe('deal scoring R1 rules', () => {
  it('规则接口、校验、金额阈值规范化、审计 / rules API and validation', async () => {
    expect((await call(scoring.GET, { token: a.token, params: { entity: 'deal' } })).json).toEqual({ entity: 'DEAL', rules: [], hotScore: 60, warmScore: 30 });
    const bad: [object, string][] = [
      [{ kind: 'FIELD_EQUALS', field: 'stage', value: 'WON', points: 5 }, 'deal'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '1.5', points: 5 }, 'deal'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '-1', points: 5 }, 'deal'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '1e5', points: 5 }, 'deal'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '12345678901234567', points: 5 }, 'deal'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'total', value: '100', points: 5 }, 'deal'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '100', maxCount: 2, points: 5 }, 'deal'],
      [{ kind: 'RELATED_COUNT', field: 'contacts', maxCount: 2, points: 5 }, 'deal'],
      [{ kind: 'FIELD_FILLED', field: 'phone', points: 5 }, 'deal'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '100', points: 5 }, 'account'],
      [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '100', points: 5 }, 'lead'],
    ];
    for (const [rule, entity] of bad) expect((await save([rule], {}, entity)).status, JSON.stringify(rule)).toBe(400);
    const r = await save([{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '000100000', points: 15 }, { kind: 'AMOUNT_AT_LEAST', field: 'amount', value: 500000, points: 15 }]);
    expect(r.status).toBe(200);
    expect(r.json.rules.map((x: { value: string }) => x.value)).toEqual(['100000', '500000']);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'scoring.update' } });
    expect(log.changes).toMatchObject({ entity: 'DEAL', rules: [[], ['amount>=100000:+15', 'amount>=500000:+15']] });
  });
});

describe('deal scoring R1 rules on deals', () => {
  it('阶段、预计成交日、描述；金额阈值按人民币与汇率折算、汇率变化自动重算 / stage, fields, amount in CNY, rates', async () => {
    await save([
      { kind: 'FIELD_EQUALS', field: 'stage', value: 'NEGOTIATION', points: 20 },
      { kind: 'FIELD_EQUALS', field: 'stage', value: 'CLOSED_LOST', points: -50 },
      { kind: 'FIELD_FILLED', field: 'expected_close_date', points: 5 },
      { kind: 'FIELD_FILLED', field: 'description', points: 2 },
      { kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '100000', points: 15 },
      { kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '500000', points: 10 },
    ]);
    const cny = await newDeal({ amount: '100000', stage: 'NEGOTIATION', expectedCloseDate: today, description: '  ' });
    expect(cny.score).toBe(40);
    await call(dealItem.PATCH, { token: a.token, params: { id: cny.id }, body: { amount: '99999.99', stage: 'CLOSED_LOST' }, method: 'PATCH' });
    expect(await scoreOf(cny.id)).toBe(-45);
    // 美元：没有汇率时金额阈值不计 / USD without a rate: thresholds do not apply
    const usd = await newDeal({ amount: '80000', currency: 'USD' });
    expect(usd.score).toBe(0);
    // 录入汇率 7.1：80000 美元 = 568000 元，两档都命中 / a 7.1 rate: 568,000 CNY meets both tiers
    expect((await setRate('USD', '7.1')).status).toBe(200);
    expect(await scoreOf(usd.id)).toBe(25);
    // 修改汇率 5：400000 元，只命中第一档 / rate 5: 400,000 CNY, first tier only
    await setRate('USD', '5');
    expect(await scoreOf(usd.id)).toBe(15);
    // 未来生效的汇率不使用 / a future rate is not used
    const future = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    await setRate('USD', '100', future);
    expect(await scoreOf(usd.id)).toBe(15);
    // 删除当前汇率：回到没有汇率 / deleting the current rate: back to no rate
    const list = (await call(rates.GET, { token: a.token })).json as { history: { id: string; currency: string; effectiveDate: string }[] };
    const current = list.history.find((x) => x.currency === 'USD' && x.effectiveDate.slice(0, 10) === today)!;
    expect((await call(rateItem.DELETE, { token: a.token, params: { id: current.id }, method: 'DELETE' })).status).toBe(204);
    expect(await scoreOf(usd.id)).toBe(0);
    // 人民币商机不受汇率影响 / CNY deals ignore rates
    expect(await scoreOf(cny.id)).toBe(-45);
  });

  it('产品明细、联系人角色与决策人、报价单、竞争对手减分、已完成跟进；明细与分级 / related records and breakdown', async () => {
    await save([
      { kind: 'RELATED_COUNT', field: 'line_items', maxCount: 2, points: 3 },
      { kind: 'RELATED_COUNT', field: 'contact_roles', maxCount: 3, points: 2 },
      { kind: 'RELATED_COUNT', field: 'decision_roles', maxCount: 1, points: 15 },
      { kind: 'RELATED_COUNT', field: 'quotes', maxCount: 2, points: 5 },
      { kind: 'RELATED_COUNT', field: 'competitors', maxCount: 3, points: -4 },
      { kind: 'ACTIVITY_COUNT', maxCount: 2, points: 6 },
    ]);
    const deal = await newDeal({});
    const p = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品', unitPrice: '100' } })).json;
    const items = [];
    for (let i = 0; i < 3; i += 1) items.push((await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: p.id, quantity: '1' } })).json.item);
    expect(await scoreOf(deal.id)).toBe(6);
    await call(dealItemsRoute.DELETE, { token: a.token, params: { id: items[0].id }, method: 'DELETE' });
    expect(await scoreOf(deal.id)).toBe(6);
    // 联系人角色：评估人、决策人 / contact roles: evaluator, decision-maker
    const c1 = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '甲' } })).json;
    const c2 = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '乙' } })).json;
    await call(dealRoles.POST, { token: a.token, params: { id: deal.id }, body: { contactId: c1.id, role: 'EVALUATOR' } });
    await call(dealRoles.POST, { token: a.token, params: { id: deal.id }, body: { contactId: c2.id, role: 'DECISION_MAKER' } });
    expect(await scoreOf(deal.id)).toBe(25);
    // 报价单 / a quote
    expect((await call(quotes.POST, { token: a.token, body: { dealId: deal.id } })).status).toBe(201);
    expect(await scoreOf(deal.id)).toBe(30);
    // 竞争对手减分；删除后扣回 / competitors subtract; removing one gives points back
    const comp = (await call(competitors.POST, { token: a.token, params: { id: deal.id }, body: { name: '对手甲' } })).json;
    await call(competitors.POST, { token: a.token, params: { id: deal.id }, body: { name: '对手乙' } });
    expect(await scoreOf(deal.id)).toBe(22);
    await call(competitorItem.DELETE, { token: a.token, params: { id: comp.id }, method: 'DELETE' });
    expect(await scoreOf(deal.id)).toBe(26);
    // 已完成跟进（上限 2）/ completed activities, capped at 2
    for (const completed of [false, true, true, true]) await call(activities.POST, { token: a.token, body: { type: 'MEETING', subject: '会议', dealId: deal.id, completed } });
    expect(await scoreOf(deal.id)).toBe(38);
    // 得分明细 / breakdown
    const detail = (await call(dealScore.GET, { token: a.token, params: { id: deal.id } })).json;
    // 保存规则时阈值为热门 40、温和 20 / the save helper sets hot 40, warm 20
    expect(detail).toMatchObject({ score: 38, grade: 'warm', hotScore: 40, warmScore: 20 });
    expect(detail.items.map((i: { field: string | null; kind: string; points: number }) => `${i.field ?? i.kind}:${i.points}`)).toEqual([
      'line_items:6',
      'contact_roles:4',
      'decision_roles:15',
      'quotes:5',
      'competitors:-4',
      'ACTIVITY_COUNT:12',
    ]);
    expect((await call(dealScore.GET, { token: a.token, params: { id: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { score: 999 }, method: 'PATCH' })).status).toBe(400);
  });
});

describe('deal scoring R1 lists and write paths', () => {
  it('列表排序与分级筛选、看板带评分、导出按分级筛选；回收站恢复 / lists, board, export, restore', async () => {
    await save([{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '1000', points: 25 }, { kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '10000', points: 25 }]);
    const big = await newDeal({ name: '大单', amount: '20000' });
    await newDeal({ name: '中单', amount: '5000' });
    await newDeal({ name: '小单', amount: '10' });
    const names = async (query: Record<string, string>) => (await call(deals.GET, { token: a.token, query })).json.items.map((d: { name: string }) => d.name);
    expect(await names({ sort: 'score' })).toEqual(['大单', '中单', '小单']);
    expect(await names({ grade: 'hot' })).toEqual(['大单']);
    expect(await names({ grade: 'warm' })).toEqual(['中单']);
    expect(await names({ grade: 'cold' })).toEqual(['小单']);
    const boardJson = (await call(board.GET, { token: a.token })).json;
    const cards = boardJson.columns.flatMap((c: { items: { name: string; score: number }[] }) => c.items);
    expect(cards.find((d: { name: string }) => d.name === '大单').score).toBe(50);
    const res = await dealExport.GET(new Request('http://localhost/api/deals/export?grade=hot', { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    const csv = await res.text();
    expect(csv).toContain('大单');
    expect(csv).not.toContain('小单');
    // 回收站恢复后按当前规则计分 / restored deals are scored by the current rules
    await call(dealItem.DELETE, { token: a.token, params: { id: big.id }, method: 'DELETE' });
    await save([{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '1', points: 7 }]);
    const item = (await call(bin.GET, { token: a.token, query: { entityType: 'deal' } })).json.items[0];
    expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    expect(await scoreOf(big.id)).toBe(7);
  });

  it('演示商机评分 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    expect(await prisma.scoringRule.count({ where: { organizationId: org.id, entity: 'DEAL' } })).toBe(DEMO_DEAL_SCORING.rules.length);
    const rows = await prisma.$queryRaw<{ score: number; total: number }[]>`
      SELECT d.score, coalesce((SELECT sum(i.points) FROM deal_score_items(d) i), 0)::int AS total FROM deals d WHERE d.organization_id = ${org.id}::uuid`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.score === r.total)).toBe(true);
    const grades = new Set(rows.map((r) => (r.score >= DEMO_DEAL_SCORING.hotScore ? 'hot' : r.score >= DEMO_DEAL_SCORING.warmScore ? 'warm' : 'cold')));
    expect([...grades].sort()).toEqual(['cold', 'hot', 'warm']);
  });
});
