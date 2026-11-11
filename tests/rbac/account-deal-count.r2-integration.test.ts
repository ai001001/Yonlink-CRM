/**
 * 客户商机数按可见范围计数 第二轮：集成测试（随改派变化、删除判断用真实总数、联系人数不受影响、组织隔离）。
 * Account deal count — round 2: integration tests (follows reassignment, delete guard uses the true total,
 * contact count unaffected, organization isolation).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let accountId: string;

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  accountId = (await call(accounts.POST, { token: sales1.token, body: { name: '销售1的客户' } })).json.id;
});

const count = async (who: Who) => (await call(accountItem.GET, { token: who.token, params: { id: accountId } })).json._count;

describe('account deal count R2', () => {
  it('经理改派商机后，销售代表的计数随之增减 / count follows reassignment', async () => {
    const d = (await call(deals.POST, { token: manager.token, body: { name: 'd', accountId, ownerId: sales2.user.id } })).json;
    expect((await count(sales1)).deals).toBe(0);
    await call(dealItem.PATCH, { token: manager.token, method: 'PATCH', params: { id: d.id }, body: { ownerId: sales1.user.id } });
    expect((await count(sales1)).deals).toBe(1);
    await call(dealItem.PATCH, { token: manager.token, method: 'PATCH', params: { id: d.id }, body: { ownerId: null } });
    expect((await count(sales1)).deals).toBe(0);
  });

  it('删除判断使用真实总数：他人负责的商机同样阻止删除，并返回真实数量 / delete guard uses the true total', async () => {
    await call(deals.POST, { token: manager.token, body: { name: 'a', accountId, ownerId: sales2.user.id } });
    await call(deals.POST, { token: manager.token, body: { name: 'b', accountId, ownerId: null } });
    const res = await call(accountItem.DELETE, { token: manager.token, method: 'DELETE', params: { id: accountId } });
    expect(res.status).toBe(409);
    expect(res.json.error.details.deals).toEqual(['2']);
    expect(await prisma.account.count({ where: { id: accountId } })).toBe(1);
  });

  it('联系人数不受影响（联系人随客户可见）/ contact count is unaffected', async () => {
    await call(accountContacts.POST, { token: sales1.token, params: { id: accountId }, body: { name: '甲' } });
    await call(accountContacts.POST, { token: manager.token, params: { id: accountId }, body: { name: '乙' } });
    expect((await count(sales1)).contacts).toBe(2);
    expect((await count(manager)).contacts).toBe(2);
  });

  it('列表中每个客户的计数都与可见商机一致（多客户）/ every account in the list matches visible deals', async () => {
    const acc2 = (await call(accounts.POST, { token: sales1.token, body: { name: '销售1的客户2' } })).json.id;
    await call(deals.POST, { token: sales1.token, body: { name: '自己的', accountId: acc2 } });
    await call(deals.POST, { token: manager.token, body: { name: '别人的', accountId: acc2, ownerId: sales2.user.id } });
    await call(deals.POST, { token: manager.token, body: { name: '别人的2', accountId, ownerId: sales2.user.id } });
    for (const who of [sales1, manager]) {
      const items = (await call(accounts.GET, { token: who.token })).json.items as { id: string; _count: { deals: number } }[];
      for (const a of items) {
        const visibleDeals = (await call(deals.GET, { token: who.token, query: { accountId: a.id } })).json.total;
        expect(a._count.deals).toBe(visibleDeals);
      }
    }
  });

  it('其他组织的商机不计入 / deals of other organizations are never counted', async () => {
    const other = await createTenant('B', 'ADMIN');
    const accB = (await call(accounts.POST, { token: other.token, body: { name: 'B' } })).json.id;
    await call(deals.POST, { token: other.token, body: { name: 'B 商机', accountId: accB } });
    expect((await count(admin)).deals).toBe(0);
  });
});
