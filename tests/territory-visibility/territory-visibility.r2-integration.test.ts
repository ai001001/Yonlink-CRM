/**
 * 区域可见范围 第二轮：集成测试（跨租户隔离、规则自动分配与重新分配、批量操作与标签仍按负责人、回收站中的记录不可见、
 * 停用的区域成员会话失效、API 密钥同样适用、经理与只读角色不变）。
 * Territory visibility round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountBulk from '@/app/api/accounts/bulk/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountTags from '@/app/api/accounts/[id]/tags/route';
import * as accounts from '@/app/api/accounts/route';
import * as contacts from '@/app/api/contacts/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as tags from '@/app/api/tags/route';
import * as apply from '@/app/api/territories/apply/route';
import * as territoryItem from '@/app/api/territories/[id]/route';
import * as territories from '@/app/api/territories/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let owner: Awaited<ReturnType<typeof addUser>>;
let hz: string;

const names = async (handler: typeof accounts.GET, token: string, query: Record<string, string> = {}) =>
  ((await call(handler, { token, query })).json.items as { name: string }[]).map((x) => x.name).sort();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '区域代表');
  owner = await addUser(a.org.id, 'SALES', '负责人');
  hz = (await call(territories.POST, { token: a.token, body: { name: '杭州', memberIds: [rep.user.id], conditions: [{ field: 'address', op: 'CONTAINS', value: '杭州' }] } })).json.id;
});

describe('territory visibility R2', () => {
  it('规则自动分配与重新分配决定可见范围 / rule assignment drives visibility', async () => {
    const acct = (await call(accounts.POST, { token: owner.token, body: { name: '杭州客户', address: '杭州市西湖区' } })).json;
    expect(acct.territoryId).toBe(hz);
    await call(deals.POST, { token: owner.token, body: { name: '杭州商机', accountId: acct.id } });
    expect(await names(accounts.GET, rep.token)).toEqual(['杭州客户']);
    expect(await names(deals.GET, rep.token)).toEqual(['杭州商机']);
    // 负责人改地址 → 自动移出区域 / the owner changes the address → leaves the territory
    await call(accountItem.PATCH, { token: owner.token, params: { id: acct.id }, body: { address: '宁波' }, method: 'PATCH' });
    expect(await names(accounts.GET, rep.token)).toEqual([]);
    expect(await names(deals.GET, rep.token)).toEqual([]);
    // 规则改为宁波并重新分配 / change the rule and reapply
    await call(territoryItem.PATCH, { token: a.token, params: { id: hz }, body: { conditions: [{ field: 'address', op: 'CONTAINS', value: '宁波' }] }, method: 'PATCH' });
    expect((await call(apply.POST, { token: a.token, body: {} })).status).toBe(200);
    expect(await names(accounts.GET, rep.token)).toEqual(['杭州客户']);
  });

  it('跨租户隔离：其他组织的区域成员看不到 / cross-tenant isolation', async () => {
    const acct = (await call(accounts.POST, { token: owner.token, body: { name: '杭州客户', address: '杭州' } })).json;
    const b = await createTenant('B');
    const bRep = await addUser(b.org.id, 'SALES', 'B代表');
    // B 组织不能引用 A 的区域 / B cannot reference A's territory
    expect((await call(territories.POST, { token: b.token, body: { name: '子', parentId: hz } })).status).toBe(400);
    await call(territories.POST, { token: b.token, body: { name: '杭州', memberIds: [bRep.user.id], conditions: [{ field: 'address', op: 'CONTAINS', value: '杭州' }] } });
    await call(accounts.POST, { token: b.token, body: { name: 'B杭州客户', address: '杭州' } });
    expect(await names(accounts.GET, bRep.token)).toEqual(['B杭州客户']);
    expect((await call(accountItem.GET, { token: bRep.token, params: { id: acct.id } })).status).toBe(404);
    expect(await names(accounts.GET, rep.token)).toEqual(['杭州客户']);
    expect(await names(contacts.GET, bRep.token)).toEqual([]);
  });

  it('批量操作、标签仍按负责人 / bulk actions and tags stay owner-only', async () => {
    const acct = (await call(accounts.POST, { token: owner.token, body: { name: '杭州客户', address: '杭州' } })).json;
    const deal = (await call(deals.POST, { token: owner.token, body: { name: '杭州商机', accountId: acct.id } })).json;
    const tag = (await call(tags.POST, { token: a.token, body: { name: '重点' } })).json;
    const bulk = await call(accountBulk.POST, { token: rep.token, body: { action: 'tag_add', ids: [acct.id], tagId: tag.id } });
    expect(bulk.json.succeeded ?? []).toEqual([]);
    const dBulk = await call(dealBulk.POST, { token: rep.token, body: { action: 'stage', ids: [deal.id], stage: 'PROPOSAL' } });
    expect(dBulk.json.succeeded ?? []).toEqual([]);
    // 拒绝（标签按负责人查找记录，故为 404）/ refused (tags look records up by owner, hence 404)
    expect([403, 404]).toContain((await call(accountTags.PUT, { token: rep.token, params: { id: acct.id }, body: { tagIds: [tag.id] }, method: 'PUT' })).status);
    expect(await prisma.accountTag.count({ where: { accountId: acct.id } })).toBe(0);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe('QUALIFICATION');
    // 没有审计写入 / no audit written by the rep
    expect(await prisma.auditLog.count({ where: { actorId: rep.user.id } })).toBe(0);
  });

  it('回收站、停用用户、API 密钥、经理与只读角色 / recycle bin, inactive users, API keys, other roles', async () => {
    const acct = (await call(accounts.POST, { token: owner.token, body: { name: '杭州客户', address: '杭州' } })).json;
    const deal = (await call(deals.POST, { token: owner.token, body: { name: '杭州商机', accountId: acct.id } })).json;
    // 删除商机（回收站）后不可见 / deleted deals disappear
    expect((await call(dealItem.DELETE, { token: a.token, params: { id: deal.id }, method: 'DELETE' })).status).toBe(204);
    expect(await names(deals.GET, rep.token)).toEqual([]);
    expect((await call(dealItem.GET, { token: rep.token, params: { id: deal.id } })).status).toBe(404);
    // 以代表身份的 API 密钥（管理员创建）同样适用 / an API key acting as the rep (created by an admin) follows the same scope
    const keys = await import('@/app/api/api-keys/route');
    const key = await call(keys.POST, { token: a.token, body: { name: '代表密钥', userId: rep.user.id } });
    expect(key.status).toBe(201);
    expect(await names(accounts.GET, key.json.key)).toEqual(['杭州客户']);
    expect((await call(accountItem.PATCH, { token: key.json.key, params: { id: acct.id }, body: { name: 'x' }, method: 'PATCH' })).status).toBe(403);
    // 经理、只读角色不变 / managers and read-only unchanged
    const mgr = await addUser(a.org.id, 'MANAGER', '经理');
    const ro = await addUser(a.org.id, 'READONLY', '只读');
    expect(await names(accounts.GET, mgr.token)).toEqual(['杭州客户']);
    expect(await names(accounts.GET, ro.token)).toEqual(['杭州客户']);
    expect((await call(accountItem.PATCH, { token: ro.token, params: { id: acct.id }, body: { name: 'x' }, method: 'PATCH' })).status).toBe(403);
    // 停用代表：会话立即失效 / deactivated rep loses access at once
    await prisma.user.update({ where: { id: rep.user.id }, data: { isActive: false } });
    expect((await call(accounts.GET, { token: rep.token })).status).toBe(401);
  });
});
