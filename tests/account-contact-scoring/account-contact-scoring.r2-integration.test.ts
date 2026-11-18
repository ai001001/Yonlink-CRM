/**
 * 客户与联系人评分 第二轮：集成测试（角色权限：所有人可查看规则与可见记录的明细、仅管理员与经理可保存；跨组织隔离；
 * 不同对象并发保存互不影响；同一客户并发新增联系人后分数准确；删除客户级联删除联系人、删除商机后联系人角色分数回落；
 * 300 个客户与 900 个联系人的重算耗时；审计日志接口筛选）。
 * Account and contact scoring round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountScore from '@/app/api/accounts/[id]/score/route';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as contactScore from '@/app/api/contacts/[id]/score/route';
import * as dealRoles from '@/app/api/deals/[id]/contact-roles/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as scoring from '@/app/api/scoring/[entity]/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales: Who & { user: { id: string } };
let viewer: Who;
const save = (who: Who, entity: string, rules: object[], extra: object = {}) =>
  call(scoring.PUT, { token: who.token, params: { entity }, body: { hotScore: 40, warmScore: 20, rules, ...extra }, method: 'PUT' });
const CONTACTS_RULE = [{ kind: 'RELATED_COUNT', field: 'contacts', maxCount: 50, points: 1 }];
const ROLE_RULE = [{ kind: 'RELATED_COUNT', field: 'deal_roles', maxCount: 5, points: 10 }];

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('account & contact scoring R2 permissions & isolation', () => {
  it('所有人可查看；仅管理员与经理可保存；明细按可见范围 / read for all, save for managers, visibility', async () => {
    expect((await save(admin, 'account', CONTACTS_RULE)).status).toBe(200);
    for (const who of [sales, viewer]) {
      for (const entity of ['account', 'contact']) {
        expect((await call(scoring.GET, { token: who.token, params: { entity } })).status).toBe(200);
        expect((await save(who, entity, [])).status).toBe(403);
      }
    }
    expect(await prisma.scoringRule.count({ where: { entity: 'ACCOUNT' } })).toBe(1);
    expect((await save(manager, 'contact', ROLE_RULE)).status).toBe(200);
    // 销售只能查看自己客户及其联系人的明细 / sales see breakdowns of their own accounts and contacts only
    const own = (await call(accounts.POST, { token: sales.token, body: { name: '销售的客户' } })).json;
    const notOwn = (await call(accounts.POST, { token: admin.token, body: { name: '管理员的客户' } })).json;
    const ownContact = (await call(accountContacts.POST, { token: sales.token, params: { id: own.id }, body: { name: '甲' } })).json;
    const otherContact = (await call(accountContacts.POST, { token: admin.token, params: { id: notOwn.id }, body: { name: '乙' } })).json;
    expect((await call(accountScore.GET, { token: sales.token, params: { id: own.id } })).json.score).toBe(1);
    expect((await call(accountScore.GET, { token: sales.token, params: { id: notOwn.id } })).status).toBe(404);
    expect((await call(contactScore.GET, { token: sales.token, params: { id: ownContact.id } })).status).toBe(200);
    expect((await call(contactScore.GET, { token: sales.token, params: { id: otherContact.id } })).status).toBe(404);
    expect((await call(contactScore.GET, { token: viewer.token, params: { id: otherContact.id } })).status).toBe(200);
  });

  it('跨组织：规则、重算、明细互不影响 / tenant isolation', async () => {
    const aAcc = (await call(accounts.POST, { token: admin.token, body: { name: 'A 客户' } })).json;
    const bAcc = (await call(accounts.POST, { token: other.token, body: { name: 'B 客户' } })).json;
    await call(accountContacts.POST, { token: admin.token, params: { id: aAcc.id }, body: { name: 'A 联系人' } });
    await call(accountContacts.POST, { token: other.token, params: { id: bAcc.id }, body: { name: 'B 联系人' } });
    expect((await save(admin, 'account', CONTACTS_RULE)).json.rescored).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: bAcc.id } })).score).toBe(0);
    expect((await call(scoring.GET, { token: other.token, params: { entity: 'account' } })).json.rules).toEqual([]);
    expect((await call(accountScore.GET, { token: other.token, params: { id: aAcc.id } })).status).toBe(404);
    await save(other, 'account', [{ kind: 'RELATED_COUNT', field: 'contacts', maxCount: 5, points: 50 }]);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: aAcc.id } })).score).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: bAcc.id } })).score).toBe(50);
  });
});

describe('account & contact scoring R2 concurrency & cascades', () => {
  it('不同对象并发保存互不影响；同一客户并发新增联系人后分数准确 / concurrent saves and contacts', async () => {
    const results = await Promise.all([
      save(admin, 'lead', [{ kind: 'FIELD_FILLED', field: 'email', points: 3 }]),
      save(manager, 'account', CONTACTS_RULE),
      save(admin, 'contact', ROLE_RULE),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await prisma.scoringRule.findMany({ orderBy: { entity: 'asc' } })).map((r) => `${r.entity}:${r.field}`)).toEqual(['LEAD:email', 'ACCOUNT:contacts', 'CONTACT:deal_roles']);
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '并发客户' } })).json;
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => call(accountContacts.POST, { token: admin.token, params: { id: acc.id }, body: { name: `并发${i}` } })));
    expect(created.every((r) => r.status === 201)).toBe(true);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).score).toBe(12);
  });

  it('删除商机后联系人角色分数回落；删除客户级联删除联系人 / cascades', async () => {
    await save(admin, 'contact', ROLE_RULE);
    await save(admin, 'account', CONTACTS_RULE);
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    const c = (await call(accountContacts.POST, { token: admin.token, params: { id: acc.id }, body: { name: '联系人' } })).json;
    const d1 = (await call(deals.POST, { token: admin.token, body: { name: '商机一', accountId: acc.id } })).json;
    const d2 = (await call(deals.POST, { token: admin.token, body: { name: '商机二', accountId: acc.id } })).json;
    for (const d of [d1, d2]) await call(dealRoles.POST, { token: admin.token, params: { id: d.id }, body: { contactId: c.id, role: 'EVALUATOR' } });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).score).toBe(20);
    expect((await call(dealItem.DELETE, { token: admin.token, params: { id: d1.id }, method: 'DELETE' })).status).toBe(204);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).score).toBe(10);
    // 删除客户：联系人、商机随之进入回收站或删除，无触发器错误 / deleting the account works with the triggers in place
    await call(dealItem.DELETE, { token: admin.token, params: { id: d2.id }, method: 'DELETE' });
    expect((await call(accountItem.DELETE, { token: admin.token, params: { id: acc.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.contact.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it('300 个客户与 900 个联系人在一次保存中重算；审计日志筛选 / scale and audit', async () => {
    const accountsData = Array.from({ length: 300 }, (_, i) => ({ id: crypto.randomUUID(), organizationId: admin.org.id, name: `批量客户${i}` }));
    await prisma.account.createMany({ data: accountsData });
    await prisma.contact.createMany({ data: accountsData.flatMap((acc, i) => Array.from({ length: 3 }, (_, j) => ({ organizationId: admin.org.id, accountId: acc.id, name: `联系人${i}-${j}`, email: j === 0 ? `c${i}@example.com` : null }))) });
    const started = Date.now();
    const r1 = await save(admin, 'account', CONTACTS_RULE);
    const r2 = await save(admin, 'contact', [{ kind: 'FIELD_FILLED', field: 'email', points: 9 }]);
    const took = Date.now() - started;
    expect([r1.json.rescored, r2.json.rescored]).toEqual([300, 900]);
    expect(await prisma.account.count({ where: { organizationId: admin.org.id, score: 3 } })).toBe(300);
    expect(await prisma.contact.count({ where: { organizationId: admin.org.id, score: 9 } })).toBe(300);
    expect(took).toBeLessThan(15_000);
    const logs = (await call(auditLogs.GET, { token: admin.token, query: { entityType: 'scoring' } })).json.items;
    expect(logs.map((l: { changes: { entity: string } }) => l.changes.entity).sort()).toEqual(['ACCOUNT', 'CONTACT']);
  }, 60_000);
});
