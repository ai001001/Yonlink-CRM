/**
 * 客户商机数按可见范围计数 第一轮：功能测试。
 * Account deal count follows visibility — round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as deals from '@/app/api/deals/route';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let accountId: string;

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  // 销售1的客户：1 个自己的商机 + 经理加的 2 个（分给销售2、未分配）
  // sales1's account: 1 own deal + 2 added by the manager (assigned to sales2, unassigned)
  accountId = (await call(accounts.POST, { token: sales1.token, body: { name: '销售1的客户' } })).json.id;
  await call(deals.POST, { token: sales1.token, body: { name: '自己的商机', accountId } });
  await call(deals.POST, { token: manager.token, body: { name: '销售2的商机', accountId, ownerId: sales2.user.id } });
  await call(deals.POST, { token: manager.token, body: { name: '未分配商机', accountId, ownerId: null } });
});

const listCount = async (who: Who) => (await call(accounts.GET, { token: who.token })).json.items.find((a: { id: string }) => a.id === accountId)?._count;
const detailCount = async (who: Who) => (await call(accountItem.GET, { token: who.token, params: { id: accountId } })).json._count;

describe('account deal count R1', () => {
  it('销售代表在列表与详情中只统计自己负责的商机 / sales rep counts own deals in list and detail', async () => {
    expect(await listCount(sales1)).toEqual({ contacts: 0, deals: 1 });
    expect(await detailCount(sales1)).toEqual({ contacts: 0, deals: 1 });
  });

  it('管理员、经理、只读用户统计全部商机 / read-all roles count every deal', async () => {
    for (const who of [admin, manager, viewer]) {
      expect((await listCount(who)).deals).toBe(3);
      expect((await detailCount(who)).deals).toBe(3);
    }
  });

  it('计数与该客户的商机列表条数一致 / count matches the account deal list', async () => {
    for (const who of [admin, manager, sales1, viewer]) {
      const list = await call(deals.GET, { token: who.token, query: { accountId } });
      expect((await detailCount(who)).deals).toBe(list.json.total);
    }
  });
});
