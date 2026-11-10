/**
 * 客户 第一轮：功能测试（客户 CRUD、搜索、详情、联系人、跟进记录）。
 * Accounts round 1: functional tests (account CRUD, search, detail, contacts, activities).
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
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

const full = {
  name: '杭州远望制造有限公司',
  industry: 'MANUFACTURING',
  phone: '0571-88880000',
  website: 'https://yuanwang.example.com',
  address: '浙江省杭州市滨江区网商路 1 号',
  description: '年采购额约 500 万',
};

const newAccount = async (body: object = full) => (await call(collection.POST, { token: a.token, body })).json;

describe('accounts R1 functional', () => {
  it('新增客户保存全部基本资料 / create saves the full profile', async () => {
    const res = await call(collection.POST, { token: a.token, body: full });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ ...full, ownerId: a.user.id, organizationId: a.org.id, contacts: [] });
    expect(res.json._count).toEqual({ contacts: 0, deals: 0 });
    expect(await prisma.account.count()).toBe(1);
  });

  it('客户详情包含联系人 / detail includes contacts', async () => {
    const acc = await newAccount();
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '陈经理', isPrimary: true } });
    const res = await call(item.GET, { token: a.token, params: { id: acc.id } });
    expect(res.status).toBe(200);
    expect(res.json.contacts.map((c: { name: string }) => c.name)).toEqual(['陈经理']);
    expect(res.json._count.contacts).toBe(1);
  });

  it('编辑客户 / update account', async () => {
    const acc = await newAccount();
    const res = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: acc.id }, body: { name: '远望集团', industry: 'IT', website: '' } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: '远望集团', industry: 'IT', website: null, phone: full.phone });
  });

  it('删除客户（无商机）并级联删除联系人与跟进 / delete account without deals cascades contacts & activities', async () => {
    const acc = await newAccount();
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '陈经理' } });
    await call(activities.POST, { token: a.token, body: { type: 'VISIT', subject: '上门拜访', accountId: acc.id } });
    const del = await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: acc.id } });
    expect(del.status).toBe(204);
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.activity.count()).toBe(0);
  });

  it('客户搜索：名称、电话、地址、联系人姓名 / search name, phone, address, contact name', async () => {
    const acc = await newAccount();
    await newAccount({ name: '北京清风科技' });
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '欧阳娜娜' } });
    const q = async (q: string) => (await call(collection.GET, { token: a.token, query: { q } })).json.items.map((x: { name: string }) => x.name);
    expect(await q('远望')).toEqual([full.name]);
    expect(await q('0571')).toEqual([full.name]);
    expect(await q('滨江')).toEqual([full.name]);
    expect(await q('欧阳')).toEqual([full.name]);
    expect(await q('清风')).toEqual(['北京清风科技']);
  });

  it('按行业筛选与分页 / filter by industry and paginate', async () => {
    for (let i = 0; i < 12; i++) await newAccount({ name: `客户${i}`, industry: i % 2 ? 'IT' : 'RETAIL' });
    const res = await call(collection.GET, { token: a.token, query: { industry: 'IT', pageSize: '5', page: '2' } });
    expect(res.json.total).toBe(6);
    expect(res.json.items).toHaveLength(1);
  });

  it('联系人新增、编辑、删除 / contact create, update, delete', async () => {
    const acc = await newAccount();
    const c = await call(accountContacts.POST, {
      token: a.token,
      params: { id: acc.id },
      body: { name: '陈经理', title: '采购总监', phone: '13700000000', email: 'Chen@Example.com' },
    });
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ accountId: acc.id, email: 'chen@example.com', isPrimary: false });
    const upd = await call(contactItem.PATCH, { token: a.token, method: 'PATCH', params: { id: c.json.id }, body: { title: '副总经理' } });
    expect(upd.json.title).toBe('副总经理');
    const list = await call(accountContacts.GET, { token: a.token, params: { id: acc.id } });
    expect(list.json.items).toHaveLength(1);
    expect((await call(contactItem.DELETE, { token: a.token, method: 'DELETE', params: { id: c.json.id } })).status).toBe(204);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('主要联系人唯一，且排在最前 / only one primary contact, listed first', async () => {
    const acc = await newAccount();
    const c1 = await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '甲', isPrimary: true } });
    const c2 = await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '乙', isPrimary: true } });
    let list = (await call(accountContacts.GET, { token: a.token, params: { id: acc.id } })).json.items;
    expect(list.map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary])).toEqual([['乙', true], ['甲', false]]);
    await call(contactItem.PATCH, { token: a.token, method: 'PATCH', params: { id: c1.json.id }, body: { isPrimary: true } });
    list = (await call(accountContacts.GET, { token: a.token, params: { id: acc.id } })).json.items;
    expect(list.filter((c: { isPrimary: boolean }) => c.isPrimary).map((c: { id: string }) => c.id)).toEqual([c1.json.id]);
    expect(c2.json.id).toBeDefined();
  });

  it('客户跟进记录：新增并按客户查询 / account follow-ups: create and list by account', async () => {
    const acc = await newAccount();
    const other = await newAccount({ name: '其他客户' });
    const r = await call(activities.POST, {
      token: a.token,
      body: { type: 'CALL', subject: '电话沟通报价', content: '客户关注交期', accountId: acc.id, completed: true },
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ accountId: acc.id, completed: true, ownerId: a.user.id, account: { id: acc.id, name: full.name } });
    expect(r.json.completedAt).not.toBeNull();
    await call(activities.POST, { token: a.token, body: { type: 'MEETING', subject: '其他客户会议', accountId: other.id } });
    const list = await call(activities.GET, { token: a.token, query: { accountId: acc.id } });
    expect(list.json.items.map((x: { subject: string }) => x.subject)).toEqual(['电话沟通报价']);
  });
});
