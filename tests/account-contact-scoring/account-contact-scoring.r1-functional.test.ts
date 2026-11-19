/**
 * 客户与联系人评分 第一轮：功能测试（按对象的规则接口与默认值、各对象的规则校验、审计记录对象、线索规则不受影响且旧地址兼容；
 * 客户：行业、资料完整度、价格表、联系人数、进行中与赢单商机（改阶段、删除）、已完成跟进、上限与负分；
 * 联系人：主要联系人、资料完整度、商机角色与决策人角色（新增、改角色、移除）；得分明细与分级；客户与联系人列表按评分排序、
 * 按分级筛选、导出按分级筛选；回收站恢复客户、线索转化、合并客户后的分数；演示数据）。
 * Account and contact scoring round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_SCORING, DEMO_CONTACT_SCORING, DEMO_ORG_NAME, DEMO_SCORING } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountScore from '@/app/api/accounts/[id]/score/route';
import * as accountExport from '@/app/api/accounts/export/route';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as contactScore from '@/app/api/contacts/[id]/score/route';
import * as contacts from '@/app/api/contacts/route';
import * as roleItem from '@/app/api/deal-contact-roles/[id]/route';
import * as dealRoles from '@/app/api/deals/[id]/contact-roles/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as merge from '@/app/api/duplicates/merge/route';
import * as leadScoring from '@/app/api/lead-scoring/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import * as pbAccounts from '@/app/api/price-books/[id]/accounts/route';
import * as books from '@/app/api/price-books/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import * as scoring from '@/app/api/scoring/[entity]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const save = (entity: string, rules: object[], extra: object = {}) =>
  call(scoring.PUT, { token: a.token, params: { entity }, body: { hotScore: 40, warmScore: 20, rules, ...extra }, method: 'PUT' });
const get = (entity: string) => call(scoring.GET, { token: a.token, params: { entity } });
const newAccount = async (body: object = {}) => (await call(accounts.POST, { token: a.token, body: { name: '客户', ...body } })).json;
const newContact = async (accountId: string, body: object = {}) => (await call(accountContacts.POST, { token: a.token, params: { id: accountId }, body: { name: '联系人', ...body } })).json;
const newDeal = async (accountId: string, body: object = {}) => (await call(deals.POST, { token: a.token, body: { name: '商机', accountId, ...body } })).json;
const accountScoreOf = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).score;
const contactScoreOf = async (id: string) => (await prisma.contact.findUniqueOrThrow({ where: { id } })).score;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('account & contact scoring R1 rules', () => {
  it('按对象的接口、默认值、校验、审计；线索规则不受影响且旧地址兼容 / per-entity API', async () => {
    expect((await get('account')).json).toEqual({ entity: 'ACCOUNT', rules: [], hotScore: 60, warmScore: 30 });
    expect((await get('contact')).json).toEqual({ entity: 'CONTACT', rules: [], hotScore: 60, warmScore: 30 });
    // 未支持的对象返回 404（商机评分上线后改用工单作为示例）/ unsupported entities are 404 (ticket now, since deals are supported)
    expect((await get('ticket')).status).toBe(404);
    // 各对象只接受自己的字段 / each entity accepts its own fields only
    const bad: [string, object][] = [
      ['account', { kind: 'FIELD_EQUALS', field: 'source', value: 'WEBSITE', points: 5 }],
      ['account', { kind: 'FIELD_EQUALS', field: 'industry', value: 'SPACE', points: 5 }],
      ['account', { kind: 'FIELD_FILLED', field: 'email', points: 5 }],
      ['account', { kind: 'RELATED_COUNT', field: 'deal_roles', maxCount: 3, points: 5 }],
      ['account', { kind: 'RELATED_COUNT', field: 'contacts', points: 5 }],
      ['contact', { kind: 'ACTIVITY_COUNT', maxCount: 3, points: 5 }],
      ['contact', { kind: 'FIELD_EQUALS', field: 'is_primary', value: 'false', points: 5 }],
      ['contact', { kind: 'FIELD_FILLED', field: 'company', points: 5 }],
      ['contact', { kind: 'RELATED_COUNT', field: 'contacts', maxCount: 3, points: 5 }],
      ['lead', { kind: 'RELATED_COUNT', field: 'contacts', maxCount: 3, points: 5 }],
    ];
    for (const [entity, rule] of bad) expect((await save(entity, [rule])).status).toBe(400);
    // 保存客户规则：重算条数、审计记录对象 / save account rules: rescored count, audited with the entity
    await newAccount();
    const leadRules = [{ kind: 'FIELD_FILLED', field: 'company', points: 7 }];
    await save('lead', leadRules);
    const r = await save('account', [{ kind: 'FIELD_FILLED', field: 'phone', points: 5 }]);
    expect(r.json).toMatchObject({ entity: 'ACCOUNT', rescored: 1, hotScore: 40, warmScore: 20 });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'scoring.update' }, orderBy: { createdAt: 'desc' } });
    expect(log.changes).toEqual({ entity: 'ACCOUNT', rescored: 1, rules: [[], ['filled:phone:+5']], hotScore: [60, 40], warmScore: [30, 20] });
    // 线索规则与阈值不受影响；旧地址等同线索 / lead rules untouched; the legacy URL equals the lead entity
    expect((await get('lead')).json.rules).toHaveLength(1);
    expect((await call(leadScoring.GET, { token: a.token })).json).toEqual((await get('lead')).json);
    await save('contact', []);
    expect((await get('account')).json.rules).toHaveLength(1);
  });
});

describe('account & contact scoring R1 accounts', () => {
  it('行业、资料、价格表、联系人、商机阶段、跟进、上限与负分 / account rules', async () => {
    await save('account', [
      { kind: 'FIELD_EQUALS', field: 'industry', value: 'MANUFACTURING', points: 10 },
      { kind: 'FIELD_FILLED', field: 'website', points: 5 },
      { kind: 'FIELD_FILLED', field: 'price_book', points: 6 },
      { kind: 'RELATED_COUNT', field: 'contacts', maxCount: 2, points: 4 },
      { kind: 'RELATED_COUNT', field: 'open_deals', maxCount: 5, points: 3 },
      { kind: 'RELATED_COUNT', field: 'won_deals', maxCount: 5, points: 20 },
      { kind: 'ACTIVITY_COUNT', maxCount: 2, points: 2 },
      { kind: 'FIELD_FILLED', field: 'address', points: -1 },
    ]);
    const acc = await newAccount({ industry: 'MANUFACTURING', website: 'example.com', address: '上海' });
    expect(acc.score).toBe(14);
    // 价格表指定与取消 / price book assignment
    const book = (await call(books.POST, { token: a.token, body: { name: '经销商价' } })).json;
    await call(pbAccounts.POST, { token: a.token, params: { id: book.id }, body: { accountId: acc.id } });
    expect(await accountScoreOf(acc.id)).toBe(20);
    // 联系人：上限 2 个 / contacts, capped at 2
    const c1 = await newContact(acc.id);
    await newContact(acc.id);
    await newContact(acc.id);
    expect(await accountScoreOf(acc.id)).toBe(28);
    // 商机：进行中 → 赢单 → 删除 / deals: open → won → deleted
    const deal = await newDeal(acc.id);
    expect(await accountScoreOf(acc.id)).toBe(31);
    await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { stage: 'CLOSED_WON' }, method: 'PATCH' });
    expect(await accountScoreOf(acc.id)).toBe(48);
    const lost = await newDeal(acc.id, { stage: 'CLOSED_LOST' });
    expect(await accountScoreOf(acc.id)).toBe(48);
    await call(dealItem.DELETE, { token: a.token, params: { id: lost.id }, method: 'DELETE' });
    // 已完成跟进：未完成不计、上限 2 条 / completed activities, capped at 2
    for (const completed of [false, true, true, true]) await call(activities.POST, { token: a.token, body: { type: 'VISIT', subject: '拜访', accountId: acc.id, completed } });
    expect(await accountScoreOf(acc.id)).toBe(52);
    // 删除联系人后仍有 2 个，不变；改行业后减 10 / delete a contact (2 left); change industry
    await call(contactItem.DELETE, { token: a.token, params: { id: c1.id }, method: 'DELETE' });
    expect(await accountScoreOf(acc.id)).toBe(52);
    await call(accountItem.PATCH, { token: a.token, params: { id: acc.id }, body: { industry: 'IT' }, method: 'PATCH' });
    expect(await accountScoreOf(acc.id)).toBe(42);
    // 得分明细与分级 / breakdown and grade
    const detail = (await call(accountScore.GET, { token: a.token, params: { id: acc.id } })).json;
    expect(detail).toMatchObject({ score: 42, grade: 'hot' });
    expect(detail.items.map((i: { kind: string; field: string | null; points: number }) => `${i.field ?? i.kind}:${i.points}`)).toEqual([
      'website:5',
      'price_book:6',
      'contacts:8',
      'won_deals:20',
      'ACTIVITY_COUNT:4',
      'address:-1',
    ]);
    // 客户端不能写入分数 / clients cannot write a score
    expect((await call(accountItem.PATCH, { token: a.token, params: { id: acc.id }, body: { score: 999 }, method: 'PATCH' })).status).toBe(400);
  });
});

describe('account & contact scoring R1 contacts', () => {
  it('主要联系人、资料完整度、商机角色与决策人角色 / contact rules', async () => {
    await save('contact', [
      { kind: 'FIELD_EQUALS', field: 'is_primary', value: 'true', points: 20 },
      { kind: 'FIELD_FILLED', field: 'email', points: 10 },
      { kind: 'RELATED_COUNT', field: 'deal_roles', maxCount: 2, points: 5 },
      { kind: 'RELATED_COUNT', field: 'decision_roles', maxCount: 3, points: 15 },
    ]);
    const acc = await newAccount();
    const c = await newContact(acc.id, { email: 'c@example.com' });
    expect(c.score).toBe(10);
    await call(contactItem.PATCH, { token: a.token, params: { id: c.id }, body: { isPrimary: true }, method: 'PATCH' });
    expect(await contactScoreOf(c.id)).toBe(30);
    // 商机角色：评估人 → 改为决策人 → 第二个商机决策人 → 第三个（角色上限 2）/ roles
    const d1 = await newDeal(acc.id);
    const d2 = await newDeal(acc.id);
    const d3 = await newDeal(acc.id);
    const role1 = (await call(dealRoles.POST, { token: a.token, params: { id: d1.id }, body: { contactId: c.id, role: 'EVALUATOR' } })).json;
    expect(await contactScoreOf(c.id)).toBe(35);
    await call(roleItem.PATCH, { token: a.token, params: { id: role1.id }, body: { role: 'DECISION_MAKER' }, method: 'PATCH' });
    expect(await contactScoreOf(c.id)).toBe(50);
    await call(dealRoles.POST, { token: a.token, params: { id: d2.id }, body: { contactId: c.id, role: 'DECISION_MAKER' } });
    await call(dealRoles.POST, { token: a.token, params: { id: d3.id }, body: { contactId: c.id, role: 'END_USER' } });
    // 主要 20 + 邮箱 10 + 角色 2×5 + 决策 2×15 = 70 / primary + email + 2 roles (capped) + 2 decisions
    expect(await contactScoreOf(c.id)).toBe(70);
    await call(roleItem.DELETE, { token: a.token, params: { id: role1.id }, method: 'DELETE' });
    expect(await contactScoreOf(c.id)).toBe(55);
    const detail = (await call(contactScore.GET, { token: a.token, params: { id: c.id } })).json;
    expect(detail).toMatchObject({ score: 55, grade: 'hot' });
    expect(detail.items.reduce((s: number, i: { points: number }) => s + i.points, 0)).toBe(55);
    expect((await call(contactScore.GET, { token: a.token, params: { id: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
  });
});

describe('account & contact scoring R1 lists and write paths', () => {
  it('客户与联系人列表按评分排序与按分级筛选、导出筛选 / lists, filters, export', async () => {
    await save('account', [{ kind: 'RELATED_COUNT', field: 'contacts', maxCount: 5, points: 10 }]);
    await save('contact', [{ kind: 'FIELD_FILLED', field: 'phone', points: 25 }]);
    const big = await newAccount({ name: '大客户' });
    const mid = await newAccount({ name: '中客户' });
    await newAccount({ name: '小客户' });
    for (let i = 0; i < 4; i += 1) await newContact(big.id, { name: `大${i}`, phone: i < 2 ? '1' : null });
    await newContact(mid.id, { name: '中联系人' });
    await newContact(mid.id, { name: '中联系人二' });
    const names = async (handler: typeof accounts.GET, query: Record<string, string>) => (await call(handler, { token: a.token, query })).json.items.map((x: { name: string }) => x.name);
    expect(await names(accounts.GET, { sort: 'score' })).toEqual(['大客户', '中客户', '小客户']);
    expect(await names(accounts.GET, { grade: 'hot' })).toEqual(['大客户']);
    expect(await names(accounts.GET, { grade: 'warm' })).toEqual(['中客户']);
    expect(await names(accounts.GET, { grade: 'cold' })).toEqual(['小客户']);
    expect((await names(contacts.GET, { grade: 'warm' })).sort()).toEqual(['大0', '大1']);
    expect((await names(contacts.GET, { sort: 'score' })).slice(0, 2).sort()).toEqual(['大0', '大1']);
    expect((await call(contacts.GET, { token: a.token, query: { grade: 'x' } })).status).toBe(400);
    const res = await accountExport.GET(new Request('http://localhost/api/accounts/export?grade=hot', { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    const csv = await res.text();
    expect(csv).toContain('大客户');
    expect(csv).not.toContain('小客户');
  });

  it('回收站恢复客户、线索转化、合并客户后的分数 / restore, conversion, merge', async () => {
    await save('account', [
      { kind: 'RELATED_COUNT', field: 'contacts', maxCount: 5, points: 10 },
      { kind: 'RELATED_COUNT', field: 'open_deals', maxCount: 5, points: 7 },
    ]);
    await save('contact', [{ kind: 'FIELD_FILLED', field: 'email', points: 9 }]);
    // 恢复：联系人一起恢复，客户分数正确 / restore: contacts come back and the account score follows
    const acc = await newAccount({ name: '待删除' });
    await newContact(acc.id, { email: 'x@example.com' });
    await newContact(acc.id);
    expect(await accountScoreOf(acc.id)).toBe(20);
    await call(accountItem.DELETE, { token: a.token, params: { id: acc.id }, method: 'DELETE' });
    const item = (await call(bin.GET, { token: a.token, query: { entityType: 'account' } })).json.items[0];
    expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    expect(await accountScoreOf(acc.id)).toBe(20);
    expect((await prisma.contact.findMany({ where: { accountId: acc.id } })).map((c) => c.score).sort()).toEqual([0, 9]);
    // 线索转化：新客户、联系人、商机 / conversion creates an account, contact and deal
    const lead = (await call(leads.POST, { token: a.token, body: { name: '转化线索', company: '转化公司', email: 'l@example.com' } })).json;
    const conv = await call(convert.POST, { token: a.token, params: { id: lead.id }, body: { account: { mode: 'new' }, deal: { name: '转化商机' } } });
    expect(conv.status).toBe(200);
    const converted = await prisma.account.findFirstOrThrow({ where: { name: '转化公司' }, include: { contacts: true } });
    expect(converted.score).toBe(17);
    expect(converted.contacts.map((c) => c.score)).toEqual([9]);
    // 合并客户：联系人与商机并入主客户 / merge: contacts and deals move to the master
    const master = await newAccount({ name: '主客户' });
    const dup = await newAccount({ name: '主客户（重复）' });
    await newContact(dup.id);
    await newDeal(dup.id);
    expect(await accountScoreOf(master.id)).toBe(0);
    const m = await call(merge.POST, { token: a.token, body: { entity: 'accounts', masterId: master.id, duplicateIds: [dup.id] } });
    expect(m.status).toBe(200);
    expect(await accountScoreOf(master.id)).toBe(17);
  });

  it('演示客户与联系人评分 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    for (const [entity, setup] of [['LEAD', DEMO_SCORING], ['ACCOUNT', DEMO_ACCOUNT_SCORING], ['CONTACT', DEMO_CONTACT_SCORING]] as const) {
      expect(await prisma.scoringRule.count({ where: { organizationId: org.id, entity } })).toBe(setup.rules.length);
    }
    const accountRows = await prisma.$queryRaw<{ score: number; total: number }[]>`
      SELECT a.score, coalesce((SELECT sum(i.points) FROM account_score_items(a) i), 0)::int AS total FROM accounts a WHERE a.organization_id = ${org.id}::uuid`;
    const contactRows = await prisma.$queryRaw<{ score: number; total: number }[]>`
      SELECT c.score, coalesce((SELECT sum(i.points) FROM contact_score_items(c) i), 0)::int AS total FROM contacts c WHERE c.organization_id = ${org.id}::uuid`;
    for (const [rows, setup] of [[accountRows, DEMO_ACCOUNT_SCORING], [contactRows, DEMO_CONTACT_SCORING]] as const) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.score === r.total)).toBe(true);
      const grades = new Set(rows.map((r) => (r.score >= setup.hotScore ? 'hot' : r.score >= setup.warmScore ? 'warm' : 'cold')));
      expect([...grades].sort()).toEqual(['cold', 'hot', 'warm']);
    }
  });
});
