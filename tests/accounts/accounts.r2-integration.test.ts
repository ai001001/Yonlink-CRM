/**
 * 客户 第二轮：集成测试（关联约束、异常输入、边界、组织隔离）。
 * Accounts round 2: integration tests (relational constraints, invalid input, boundaries, isolation).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as activities from '@/app/api/activities/route';
import * as collection from '@/app/api/accounts/route';
import * as item from '@/app/api/accounts/[id]/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

const mk = async (token: string, name = '客户') => (await call(collection.POST, { token, body: { name } })).json;

describe('accounts R2 relations & constraints', () => {
  it('存在商机的客户不能删除（409），客户与商机均保留 / account with deals cannot be deleted', async () => {
    const acc = await mk(a.token);
    await prisma.deal.create({ data: { organizationId: a.org.id, accountId: acc.id, name: '商机', amount: '1000.00' } });
    const res = await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: acc.id } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('CONFLICT');
    expect(await prisma.account.count()).toBe(1);
    expect(await prisma.deal.count()).toBe(1);
  });

  it('数据库 RESTRICT 外键兜底（绕过服务层直接删除）/ DB RESTRICT FK backs it up', async () => {
    const acc = await mk(a.token);
    await prisma.deal.create({ data: { organizationId: a.org.id, accountId: acc.id, name: '商机' } });
    await expect(prisma.account.delete({ where: { id: acc.id } })).rejects.toThrow();
  });

  it('列表 _count 正确反映联系人与商机数 / list counts contacts and deals', async () => {
    const acc = await mk(a.token);
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '甲' } });
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '乙' } });
    await prisma.deal.create({ data: { organizationId: a.org.id, accountId: acc.id, name: '商机' } });
    const res = await call(collection.GET, { token: a.token });
    expect(res.json.items[0]._count).toEqual({ contacts: 2, deals: 1 });
  });

  it('联系人必须挂在已存在的客户下 / contacts require an existing account', async () => {
    const res = await call(accountContacts.POST, { token: a.token, params: { id: '00000000-0000-4000-8000-000000000000' }, body: { name: 'x' } });
    expect(res.status).toBe(404);
  });

  it('跟进记录引用不存在的客户 → 400 / activity with unknown account → 400', async () => {
    const res = await call(activities.POST, {
      token: a.token,
      body: { type: 'CALL', subject: 'x', accountId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.details.accountId).toBeDefined();
  });
});

describe('accounts R2 invalid input & boundaries', () => {
  it.each([
    [{}],
    [{ name: '' }],
    [{ name: 'x'.repeat(201) }],
    [{ name: 'x', industry: 'SPACE' }],
    [{ name: 'x', address: 'x'.repeat(501) }],
    [{ name: 'x', organizationId: '00000000-0000-4000-8000-000000000000' }],
    [{ name: 'x', _count: { deals: 0 } }],
  ])('非法客户输入 %j → 400', async (body) => {
    expect((await call(collection.POST, { token: a.token, body })).status).toBe(400);
    expect(await prisma.account.count()).toBe(0);
  });

  it.each([
    [{}],
    [{ name: '  ' }],
    [{ name: 'x', email: 'bad@' }],
    [{ name: 'x', isPrimary: 'yes' }],
    [{ name: 'x', accountId: '00000000-0000-4000-8000-000000000000' }],
  ])('非法联系人输入 %j → 400', async (body) => {
    const acc = await mk(a.token);
    expect((await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body })).status).toBe(400);
  });

  it('联系人不能通过更新改挂到其他客户 / a contact cannot be moved by update', async () => {
    const acc1 = await mk(a.token, '一');
    const acc2 = await mk(a.token, '二');
    const c = await call(accountContacts.POST, { token: a.token, params: { id: acc1.id }, body: { name: 'x' } });
    const res = await call(contactItem.PATCH, { token: a.token, method: 'PATCH', params: { id: c.json.id }, body: { accountId: acc2.id } });
    expect(res.status).toBe(400);
  });

  it('客户名称 200 字符边界 / 200-char name boundary', async () => {
    expect((await call(collection.POST, { token: a.token, body: { name: '客'.repeat(200) } })).status).toBe(201);
  });

  it.each([[{ industry: 'nope' }], [{ pageSize: '0' }], [{ ownerId: 'x' }]])('非法查询 %j → 400', async (query) => {
    expect((await call(collection.GET, { token: a.token, query })).status).toBe(400);
  });
});

describe('accounts R2 organization isolation', () => {
  it('列表、搜索只含本组织 / list and search scoped', async () => {
    await mk(a.token, '同名客户');
    await mk(b.token, '同名客户');
    const res = await call(collection.GET, { token: a.token, query: { q: '同名' } });
    expect(res.json.total).toBe(1);
  });

  it('跨组织读/改/删客户 → 404 且数据不变 / IDOR on accounts', async () => {
    const acc = await mk(b.token, 'B 客户');
    for (const [h, method, body] of [
      [item.GET, 'GET', undefined],
      [item.PATCH, 'PATCH', { name: '篡改' }],
      [item.DELETE, 'DELETE', undefined],
    ] as const) {
      expect((await call(h, { token: a.token, method, params: { id: acc.id }, body })).status).toBe(404);
    }
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).name).toBe('B 客户');
  });

  it('跨组织读/建联系人 → 404 / IDOR on account contacts', async () => {
    const acc = await mk(b.token);
    expect((await call(accountContacts.GET, { token: a.token, params: { id: acc.id } })).status).toBe(404);
    expect((await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '入侵' } })).status).toBe(404);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('跨组织改/删联系人 → 404 / IDOR on contacts', async () => {
    const acc = await mk(b.token);
    const c = await call(accountContacts.POST, { token: b.token, params: { id: acc.id }, body: { name: 'B 联系人' } });
    expect((await call(contactItem.PATCH, { token: a.token, method: 'PATCH', params: { id: c.json.id }, body: { name: '篡改' } })).status).toBe(404);
    expect((await call(contactItem.DELETE, { token: a.token, method: 'DELETE', params: { id: c.json.id } })).status).toBe(404);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.json.id } })).name).toBe('B 联系人');
  });

  it('设置主要联系人不影响其他组织 / setting primary does not touch other orgs', async () => {
    const accB = await mk(b.token);
    const cb = await call(accountContacts.POST, { token: b.token, params: { id: accB.id }, body: { name: 'B', isPrimary: true } });
    const accA = await mk(a.token);
    await call(accountContacts.POST, { token: a.token, params: { id: accA.id }, body: { name: 'A', isPrimary: true } });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: cb.json.id } })).isPrimary).toBe(true);
  });

  it('不能为其他组织客户创建跟进记录 / cannot attach activity to another org account', async () => {
    const acc = await mk(b.token);
    const res = await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: 'x', accountId: acc.id } });
    expect(res.status).toBe(400);
    expect(await prisma.activity.count()).toBe(0);
    const list = await call(activities.GET, { token: a.token, query: { accountId: acc.id } });
    expect(list.json.total).toBe(0);
  });

  it('数据库复合外键阻止跨组织联系人 / composite FK blocks cross-org contact', async () => {
    const acc = await mk(b.token);
    await expect(prisma.contact.create({ data: { organizationId: a.org.id, accountId: acc.id, name: '绕过' } })).rejects.toThrow();
  });
});
