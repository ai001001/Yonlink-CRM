/**
 * 联系人列表 第二轮：集成测试（销售代表只看自己负责客户的联系人、负责人筛选不越权、只读可看不可改、导出权限、
 * 跨组织隔离、参数校验与未登录、客户删除后联系人消失、不能在他人或他组织客户下新建）。
 * Contacts list round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as contactExport from '@/app/api/contacts/export/route';
import * as contacts from '@/app/api/contacts/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let sales1: Who;
let sales2: Who;
let viewer: Who;
let acc1: { id: string };
let acc2: { id: string };
let c1: { id: string };
let c2: { id: string };

const names = async (who: Who, query: Record<string, string> = {}) => ((await call(contacts.GET, { token: who.token, query })).json.items as { name: string }[]).map((x) => x.name).sort();
const exportStatus = async (who: Who) => {
  const res = await contactExport.GET(new Request('http://localhost/api/contacts/export', { headers: { authorization: `Bearer ${who.token}` } }), { params: Promise.resolve({}) });
  return res.status;
};

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  acc1 = (await call(accounts.POST, { token: sales1.token, body: { name: '销售1客户' } })).json;
  acc2 = (await call(accounts.POST, { token: sales2.token, body: { name: '销售2客户' } })).json;
  c1 = (await call(accountContacts.POST, { token: sales1.token, params: { id: acc1.id }, body: { name: '甲联系人' } })).json;
  c2 = (await call(accountContacts.POST, { token: sales2.token, params: { id: acc2.id }, body: { name: '乙联系人' } })).json;
  const accB = (await call(accounts.POST, { token: other.token, body: { name: '乙组织客户' } })).json;
  await call(accountContacts.POST, { token: other.token, params: { id: accB.id }, body: { name: '丙联系人' } });
});

describe('contacts list R2 scope', () => {
  it('销售只看自己负责客户的联系人；负责人与客户筛选不越权 / sales reps see their own', async () => {
    expect(await names(sales1)).toEqual(['甲联系人']);
    expect(await names(sales1, { ownerId: sales2.user.id })).toEqual([]);
    expect(await names(sales1, { accountId: acc2.id })).toEqual([]);
    expect(await names(sales1, { q: '乙' })).toEqual([]);
    expect((await call(contactItem.GET, { token: sales1.token, params: { id: c2.id } })).status).toBe(404);
    for (const who of [admin, viewer]) expect(await names(who)).toEqual(['乙联系人', '甲联系人']);
  });

  it('只读可看不可改；销售不能改他人客户的联系人 / read-only and foreign edits', async () => {
    expect((await call(contactItem.GET, { token: viewer.token, params: { id: c1.id } })).status).toBe(200);
    expect((await call(contactItem.PATCH, { token: viewer.token, params: { id: c1.id }, body: { title: 'x' }, method: 'PATCH' })).status).toBe(403);
    expect((await call(contactItem.PATCH, { token: sales2.token, params: { id: c1.id }, body: { title: 'x' }, method: 'PATCH' })).status).toBe(404);
    expect((await call(accountContacts.POST, { token: sales2.token, params: { id: acc1.id }, body: { name: '越权' } })).status).toBe(404);
    expect((await call(accountContacts.POST, { token: viewer.token, params: { id: acc1.id }, body: { name: '越权' } })).status).toBe(403);
    expect(await prisma.contact.count({ where: { name: '越权' } })).toBe(0);
  });

  it('导出：管理员与经理可以，销售与只读 403 / export permission', async () => {
    const manager = await addUser(admin.org.id, 'MANAGER');
    expect(await exportStatus(admin)).toBe(200);
    expect(await exportStatus(manager)).toBe(200);
    expect(await exportStatus(sales1)).toBe(403);
    expect(await exportStatus(viewer)).toBe(403);
  });

  it('跨组织隔离 / cross-tenant isolation', async () => {
    expect(await names(other)).toEqual(['丙联系人']);
    expect(await names(other, { accountId: acc1.id })).toEqual([]);
    expect((await call(contactItem.GET, { token: other.token, params: { id: c1.id } })).status).toBe(404);
    expect((await call(accountContacts.POST, { token: other.token, params: { id: acc1.id }, body: { name: '越权' } })).status).toBe(404);
  });
});

describe('contacts list R2 integrity', () => {
  it('参数校验与未登录 / validation and auth', async () => {
    for (const query of [{ accountId: 'x' }, { ownerId: 'x' }, { isPrimary: 'yes' }, { pageSize: '101' }, { page: '0' }, { q: 'x'.repeat(101) }] as Record<string, string>[]) {
      expect((await call(contacts.GET, { token: admin.token, query })).status).toBe(400);
    }
    expect((await call(contacts.GET)).status).toBe(401);
    expect((await call(contactItem.GET, { params: { id: c1.id } })).status).toBe(401);
    expect((await call(contactItem.GET, { token: admin.token, params: { id: 'abc' } })).status).toBe(404);
  });

  it('客户删除后其联系人从列表消失 / contacts go with their account', async () => {
    expect((await call(accountItem.DELETE, { token: admin.token, params: { id: acc2.id }, method: 'DELETE' })).status).toBe(204);
    expect(await names(admin)).toEqual(['甲联系人']);
    expect((await call(contactItem.GET, { token: admin.token, params: { id: c2.id } })).status).toBe(404);
  });
});
