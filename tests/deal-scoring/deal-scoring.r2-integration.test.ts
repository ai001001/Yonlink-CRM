/**
 * 商机评分 第二轮：集成测试（角色权限：所有人可查看规则与可见商机的明细、仅管理员与经理可保存；跨组织隔离（规则、汇率只影响
 * 本组织）；同一商机并发添加产品明细后分数准确；四类评分规则并发保存互不影响；2000 个商机的重算与汇率变更耗时；
 * 删除客户与商机时触发器不出错；审计日志筛选）。
 * Deal scoring round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as dealScore from '@/app/api/deals/[id]/score/route';
import * as deals from '@/app/api/deals/route';
import * as rates from '@/app/api/exchange-rates/route';
import * as products from '@/app/api/products/route';
import * as scoring from '@/app/api/scoring/[entity]/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales: Who & { user: { id: string } };
let viewer: Who;
const today = new Date().toISOString().slice(0, 10);
const AMOUNT = [{ kind: 'AMOUNT_AT_LEAST', field: 'amount', value: '100000', points: 30 }];
const save = (who: Who, rules: object[], entity = 'deal') => call(scoring.PUT, { token: who.token, params: { entity }, body: { hotScore: 40, warmScore: 20, rules }, method: 'PUT' });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('deal scoring R2 permissions & isolation', () => {
  it('所有人可查看；仅管理员与经理可保存；明细按可见范围 / read for all, save for managers, visibility', async () => {
    expect((await save(admin, AMOUNT)).status).toBe(200);
    for (const who of [sales, viewer]) {
      expect((await call(scoring.GET, { token: who.token, params: { entity: 'deal' } })).json.rules).toHaveLength(1);
      expect((await save(who, [])).status).toBe(403);
    }
    expect((await save(manager, AMOUNT)).status).toBe(200);
    const ownAcc = (await call(accounts.POST, { token: sales.token, body: { name: '销售客户' } })).json;
    const own = (await call(deals.POST, { token: sales.token, body: { name: '销售商机', accountId: ownAcc.id, amount: '200000' } })).json;
    const adminAcc = (await call(accounts.POST, { token: admin.token, body: { name: '管理员客户' } })).json;
    const notOwn = (await call(deals.POST, { token: admin.token, body: { name: '管理员商机', accountId: adminAcc.id, amount: '200000' } })).json;
    expect((await call(dealScore.GET, { token: sales.token, params: { id: own.id } })).json.score).toBe(30);
    expect((await call(dealScore.GET, { token: sales.token, params: { id: notOwn.id } })).status).toBe(404);
    expect((await call(dealScore.GET, { token: viewer.token, params: { id: notOwn.id } })).json.score).toBe(30);
  });

  it('跨组织：规则与汇率只影响本组织 / rules and rates are per organization', async () => {
    const aAcc = (await call(accounts.POST, { token: admin.token, body: { name: 'A 客户' } })).json;
    const bAcc = (await call(accounts.POST, { token: other.token, body: { name: 'B 客户' } })).json;
    const aDeal = (await call(deals.POST, { token: admin.token, body: { name: 'A 美元商机', accountId: aAcc.id, amount: '20000', currency: 'USD' } })).json;
    const bDeal = (await call(deals.POST, { token: other.token, body: { name: 'B 美元商机', accountId: bAcc.id, amount: '20000', currency: 'USD' } })).json;
    await save(admin, AMOUNT);
    await save(other, AMOUNT);
    // 只有 B 录入汇率：只有 B 的商机命中 / only B enters a rate: only B's deal matches
    expect((await call(rates.PUT, { token: other.token, body: { currency: 'USD', rate: '7', effectiveDate: today }, method: 'PUT' })).status).toBe(200);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: aDeal.id } })).score).toBe(0);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: bDeal.id } })).score).toBe(30);
    expect((await call(dealScore.GET, { token: other.token, params: { id: aDeal.id } })).status).toBe(404);
    // A 的规则改为 0 条不影响 B / clearing A's rules leaves B alone
    expect((await save(admin, [])).json.rescored).toBe(1);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: bDeal.id } })).score).toBe(30);
  });
});

describe('deal scoring R2 concurrency, cascades & scale', () => {
  it('并发添加产品明细后分数准确；四类规则并发保存互不影响；删除客户与商机不出错 / concurrency and cascades', async () => {
    await save(admin, [{ kind: 'RELATED_COUNT', field: 'line_items', maxCount: 50, points: 1 }]);
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: admin.token, body: { name: '并发商机', accountId: acc.id } })).json;
    const p = (await call(products.POST, { token: admin.token, body: { sku: 'P-1', name: '产品', unitPrice: '10' } })).json;
    const results = await Promise.all(Array.from({ length: 10 }, () => call(dealItems.POST, { token: admin.token, params: { id: deal.id }, body: { productId: p.id, quantity: '1' } })));
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).score).toBe(10);
    const saves = await Promise.all([
      save(admin, [{ kind: 'FIELD_FILLED', field: 'email', points: 1 }], 'lead'),
      save(manager, [{ kind: 'FIELD_FILLED', field: 'phone', points: 1 }], 'account'),
      save(admin, [{ kind: 'FIELD_FILLED', field: 'title', points: 1 }], 'contact'),
      save(manager, AMOUNT, 'deal'),
    ]);
    expect(saves.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await prisma.scoringRule.findMany({ orderBy: { entity: 'asc' } })).map((r) => `${r.entity}:${r.field}`)).toEqual(['LEAD:email', 'ACCOUNT:phone', 'CONTACT:title', 'DEAL:amount']);
    // 删除商机（明细级联）与客户 / delete the deal (items cascade) and the account
    expect((await call(dealItem.DELETE, { token: admin.token, params: { id: deal.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(accountItem.DELETE, { token: admin.token, params: { id: acc.id }, method: 'DELETE' })).status).toBe(204);
  });

  it('2000 个商机的重算与汇率变更耗时；审计日志筛选 / scale and audit', async () => {
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '批量客户' } })).json;
    await prisma.deal.createMany({ data: Array.from({ length: 2000 }, (_, i) => ({ organizationId: admin.org.id, accountId: acc.id, name: `批量${i}`, amount: String((i % 2) * 20000), currency: 'USD' })) });
    let started = Date.now();
    const r = await save(admin, AMOUNT);
    expect(r.json.rescored).toBe(2000);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await prisma.deal.count({ where: { organizationId: admin.org.id, score: 30 } })).toBe(0);
    // 录入汇率触发 2000 个美元商机重算 / entering a rate rescores the 2,000 USD deals
    started = Date.now();
    expect((await call(rates.PUT, { token: admin.token, body: { currency: 'USD', rate: '7.1', effectiveDate: today }, method: 'PUT' })).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await prisma.deal.count({ where: { organizationId: admin.org.id, score: 30 } })).toBe(1000);
    const logs = (await call(auditLogs.GET, { token: admin.token, query: { entityType: 'scoring' } })).json.items;
    expect(logs.map((l: { changes: { entity: string } }) => l.changes.entity)).toContain('DEAL');
  }, 60_000);
});
