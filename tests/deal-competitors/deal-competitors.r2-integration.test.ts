/**
 * 商机竞争对手与联系人角色 第二轮：集成测试（销售只能管理自己商机的、只读只能查看、经理可管理；
 * 跨组织隔离与跨组织联系人；参数校验与未登录；并发：同一联系人重复添加、同时设主要联系人、
 * 换客户与添加角色、同名竞争对手；销售看到的报表只含自己的商机；跨域预检）。
 * Deal competitors and contact roles round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accounts from '@/app/api/accounts/route';
import * as competitorItem from '@/app/api/deal-competitors/[id]/route';
import * as roleItem from '@/app/api/deal-contact-roles/[id]/route';
import * as dealCompetitors from '@/app/api/deals/[id]/competitors/route';
import * as dealRoles from '@/app/api/deals/[id]/contact-roles/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as sales from '@/app/api/reports/sales/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let acc: { id: string };
let deal1: { id: string };
let deal2: { id: string };
let c1: { id: string };
let c2: { id: string };

const contact = async (token: string, accountId: string, name: string) => (await call(accountContacts.POST, { token, params: { id: accountId }, body: { name } })).json;

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  acc = (await call(accounts.POST, { token: admin.token, body: { name: '共享客户', ownerId: sales1.user.id } })).json;
  deal1 = (await call(deals.POST, { token: admin.token, body: { name: '销售1商机', accountId: acc.id, ownerId: sales1.user.id } })).json;
  deal2 = (await call(deals.POST, { token: admin.token, body: { name: '销售2商机', accountId: acc.id, ownerId: sales2.user.id } })).json;
  c1 = await contact(admin.token, acc.id, '张总');
  c2 = await contact(admin.token, acc.id, '李工');
});

describe('deal competitors & roles R2 permissions', () => {
  it('销售只能管理自己商机；他人商机不可见 / sales manage their own deals only', async () => {
    const own = await call(dealRoles.POST, { token: sales1.token, params: { id: deal1.id }, body: { contactId: c1.id, role: 'DECISION_MAKER' } });
    expect(own.status).toBe(201);
    expect((await call(dealCompetitors.POST, { token: sales1.token, params: { id: deal1.id }, body: { name: '对手' } })).status).toBe(201);
    // 销售2看不到销售1的商机 / sales2 cannot see sales1's deal
    expect((await call(dealRoles.GET, { token: sales2.token, params: { id: deal1.id } })).status).toBe(404);
    expect((await call(dealCompetitors.GET, { token: sales2.token, params: { id: deal1.id } })).status).toBe(404);
    expect((await call(dealRoles.POST, { token: sales2.token, params: { id: deal1.id }, body: { contactId: c2.id, role: 'OTHER' } })).status).toBe(404);
    expect((await call(roleItem.PATCH, { token: sales2.token, params: { id: own.json.id }, body: { role: 'OTHER' }, method: 'PATCH' })).status).toBe(404);
    expect((await call(roleItem.DELETE, { token: sales2.token, params: { id: own.json.id }, method: 'DELETE' })).status).toBe(404);
    const comp = await prisma.dealCompetitor.findFirstOrThrow();
    expect((await call(competitorItem.PATCH, { token: sales2.token, params: { id: comp.id }, body: { name: '改' }, method: 'PATCH' })).status).toBe(404);
    expect((await call(competitorItem.DELETE, { token: sales2.token, params: { id: comp.id }, method: 'DELETE' })).status).toBe(404);
    expect(await prisma.dealContactRole.count()).toBe(1);
    expect((await prisma.dealCompetitor.findFirstOrThrow()).name).toBe('对手');
  });

  it('只读可查看不可修改；经理可管理 / readonly views, manager manages', async () => {
    const role = (await call(dealRoles.POST, { token: admin.token, params: { id: deal2.id }, body: { contactId: c1.id, role: 'EVALUATOR' } })).json;
    const comp = (await call(dealCompetitors.POST, { token: admin.token, params: { id: deal2.id }, body: { name: '对手' } })).json;
    expect((await call(dealRoles.GET, { token: viewer.token, params: { id: deal2.id } })).json.roles).toHaveLength(1);
    expect((await call(dealCompetitors.GET, { token: viewer.token, params: { id: deal2.id } })).json.items).toHaveLength(1);
    expect((await call(dealRoles.POST, { token: viewer.token, params: { id: deal2.id }, body: { contactId: c2.id, role: 'OTHER' } })).status).toBe(403);
    expect((await call(roleItem.PATCH, { token: viewer.token, params: { id: role.id }, body: { role: 'OTHER' }, method: 'PATCH' })).status).toBe(403);
    expect((await call(roleItem.DELETE, { token: viewer.token, params: { id: role.id }, method: 'DELETE' })).status).toBe(403);
    expect((await call(dealCompetitors.POST, { token: viewer.token, params: { id: deal2.id }, body: { name: '越权' } })).status).toBe(403);
    expect((await call(competitorItem.PATCH, { token: viewer.token, params: { id: comp.id }, body: { name: '越权' }, method: 'PATCH' })).status).toBe(403);
    expect((await call(competitorItem.DELETE, { token: viewer.token, params: { id: comp.id }, method: 'DELETE' })).status).toBe(403);
    expect((await call(roleItem.PATCH, { token: manager.token, params: { id: role.id }, body: { role: 'OTHER' }, method: 'PATCH' })).json.role).toBe('OTHER');
    expect((await call(competitorItem.DELETE, { token: manager.token, params: { id: comp.id }, method: 'DELETE' })).status).toBe(204);
    // 审计记录操作人 / audit records the actor
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'deal.remove_competitor' } })).actorId).toBe(manager.user.id);
  });

  it('跨组织隔离；不能引用其他组织的联系人 / cross-tenant isolation', async () => {
    const role = (await call(dealRoles.POST, { token: admin.token, params: { id: deal1.id }, body: { contactId: c1.id, role: 'OTHER' } })).json;
    const comp = (await call(dealCompetitors.POST, { token: admin.token, params: { id: deal1.id }, body: { name: '对手' } })).json;
    expect((await call(dealRoles.GET, { token: other.token, params: { id: deal1.id } })).status).toBe(404);
    expect((await call(dealCompetitors.GET, { token: other.token, params: { id: deal1.id } })).status).toBe(404);
    expect((await call(roleItem.PATCH, { token: other.token, params: { id: role.id }, body: { role: 'END_USER' }, method: 'PATCH' })).status).toBe(404);
    expect((await call(roleItem.DELETE, { token: other.token, params: { id: role.id }, method: 'DELETE' })).status).toBe(404);
    expect((await call(competitorItem.PATCH, { token: other.token, params: { id: comp.id }, body: { name: 'x' }, method: 'PATCH' })).status).toBe(404);
    expect((await call(competitorItem.DELETE, { token: other.token, params: { id: comp.id }, method: 'DELETE' })).status).toBe(404);
    // 其他组织的商机引用本组织联系人 → 联系人不存在 / another org's deal cannot reference this org's contact
    const oAcc = (await call(accounts.POST, { token: other.token, body: { name: '乙方客户' } })).json;
    const oDeal = (await call(deals.POST, { token: other.token, body: { name: '乙方商机', accountId: oAcc.id } })).json;
    const r = await call(dealRoles.POST, { token: other.token, params: { id: oDeal.id }, body: { contactId: c1.id, role: 'OTHER' } });
    expect(r.status).toBe(400);
    expect(r.json.error.details).toEqual({ contactId: ['not_found'] });
    expect(await prisma.dealContactRole.count({ where: { organizationId: other.org.id } })).toBe(0);
  });
});

describe('deal competitors & roles R2 validation & concurrency', () => {
  it('参数校验与未登录 / validation and auth', async () => {
    const badRoles = [{}, { contactId: 'x', role: 'OTHER' }, { contactId: c1.id }, { contactId: c1.id, role: 'OTHER', isPrimary: 'yes' }, { contactId: c1.id, role: 'OTHER', organizationId: other.org.id }, { contactId: c1.id, role: 'OTHER', dealId: deal2.id }];
    for (const body of badRoles) expect((await call(dealRoles.POST, { token: admin.token, params: { id: deal1.id }, body })).status).toBe(400);
    const badComps = [{}, { name: '' }, { name: 'x', threatLevel: 'low' }, { name: 'x', strengths: 'y'.repeat(5001) }, { name: 'x', dealId: deal2.id }, { name: 'x', organizationId: other.org.id }];
    for (const body of badComps) expect((await call(dealCompetitors.POST, { token: admin.token, params: { id: deal1.id }, body })).status).toBe(400);
    expect((await call(dealRoles.GET, { token: admin.token, params: { id: 'not-a-uuid' } })).status).toBe(404);
    expect((await call(dealRoles.GET, { params: { id: deal1.id } })).status).toBe(401);
    expect((await call(dealCompetitors.POST, { params: { id: deal1.id }, body: { name: 'x' } })).status).toBe(401);
    expect(await prisma.dealContactRole.count()).toBe(0);
    expect(await prisma.dealCompetitor.count()).toBe(0);
  });

  it('并发：同一联系人、同名对手只成功一个；主要联系人始终唯一 / concurrency', async () => {
    const adds = await Promise.all(Array.from({ length: 4 }, () => call(dealRoles.POST, { token: admin.token, params: { id: deal1.id }, body: { contactId: c1.id, role: 'OTHER' } })));
    expect(adds.filter((r) => r.status === 201)).toHaveLength(1);
    expect(adds.filter((r) => r.status === 409)).toHaveLength(3);
    const comps = await Promise.all(['对手', '对手', ' 对手 ', '对手'].map((name) => call(dealCompetitors.POST, { token: admin.token, params: { id: deal1.id }, body: { name } })));
    expect(comps.filter((r) => r.status === 201)).toHaveLength(1);
    expect(comps.filter((r) => r.status === 409)).toHaveLength(3);
    const c3 = await contact(admin.token, acc.id, '王采购');
    const r1 = adds.find((r) => r.status === 201)!.json;
    const r2 = (await call(dealRoles.POST, { token: admin.token, params: { id: deal1.id }, body: { contactId: c2.id, role: 'OTHER' } })).json;
    const r3 = (await call(dealRoles.POST, { token: admin.token, params: { id: deal1.id }, body: { contactId: c3.id, role: 'OTHER' } })).json;
    const prim = await Promise.all([r1, r2, r3].map((r) => call(roleItem.PATCH, { token: admin.token, params: { id: r.id }, body: { isPrimary: true }, method: 'PATCH' })));
    for (const p of prim) expect([200, 409]).toContain(p.status);
    expect(prim.some((p) => p.status === 200)).toBe(true);
    expect(await prisma.dealContactRole.count({ where: { dealId: deal1.id, isPrimary: true } })).toBe(1);
  });

  it('换客户与添加角色并发：不会留下其他客户联系人的角色 / account change vs add role', async () => {
    const acc2 = (await call(accounts.POST, { token: admin.token, body: { name: '新客户' } })).json;
    for (let i = 0; i < 3; i++) {
      await call(dealItem.PATCH, { token: admin.token, params: { id: deal1.id }, body: { accountId: acc.id }, method: 'PATCH' });
      await prisma.dealContactRole.deleteMany({});
      const [move, add] = await Promise.all([
        call(dealItem.PATCH, { token: admin.token, params: { id: deal1.id }, body: { accountId: acc2.id }, method: 'PATCH' }),
        call(dealRoles.POST, { token: admin.token, params: { id: deal1.id }, body: { contactId: c1.id, role: 'OTHER' } }),
      ]);
      expect(move.status).toBe(200);
      expect([201, 400]).toContain(add.status);
      // 无论先后，商机已在新客户下，旧客户联系人的角色都不存在 / either way no role of the old account survives
      expect(await prisma.dealContactRole.count({ where: { dealId: deal1.id } })).toBe(0);
    }
  });

  it('销售看到的竞争对手胜负只含自己的商机 / report scope for sales', async () => {
    await call(dealCompetitors.POST, { token: admin.token, params: { id: deal1.id }, body: { name: '对手' } });
    await call(dealCompetitors.POST, { token: admin.token, params: { id: deal2.id }, body: { name: '对手' } });
    const mine = (await call(sales.GET, { token: sales1.token, query: { currency: 'CNY' } })).json.competitors;
    expect(mine).toEqual([{ name: '对手', openCount: 1, wonCount: 0, lostCount: 0, lostAmount: '0.00', winRate: null }]);
    // 销售指定他人也只看自己 / a forced owner wins over the requested one
    expect((await call(sales.GET, { token: sales1.token, query: { currency: 'CNY', ownerId: sales2.user.id } })).json.competitors).toEqual([]);
    expect((await call(sales.GET, { token: manager.token, query: { currency: 'CNY' } })).json.competitors[0].openCount).toBe(2);
  });
});

describe('deal competitors & roles R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检 / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    for (const [route, methods] of [
      [dealRoles, ['GET', 'POST']],
      [roleItem, ['PATCH', 'DELETE']],
      [dealCompetitors, ['GET', 'POST']],
      [competitorItem, ['PATCH', 'DELETE']],
    ] as const) {
      const res = await route.OPTIONS(new Request('http://localhost/api/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
      for (const m of methods) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
    }
  });
});
