/**
 * 联系人列表 第一轮：功能测试（跨客户列表与排序、各字段搜索与通配符转义、客户 / 负责人 / 主要联系人筛选、详情、导出与审计）。
 * Contacts list round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accounts from '@/app/api/accounts/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as contactExport from '@/app/api/contacts/export/route';
import * as contacts from '@/app/api/contacts/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc1: { id: string };
let acc2: { id: string };
let sales: Awaited<ReturnType<typeof addUser>>;

const add = async (accountId: string, body: object) => {
  const r = await call(accountContacts.POST, { token: a.token, params: { id: accountId }, body });
  expect(r.status).toBe(201);
  return r.json as { id: string };
};
const list = async (query: Record<string, string> = {}) => (await call(contacts.GET, { token: a.token, query })).json;
const names = (r: { items: { name: string }[] }) => r.items.map((x) => x.name);

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  sales = await addUser(a.org.id, 'SALES', 'S');
  acc1 = (await call(accounts.POST, { token: a.token, body: { name: '星河科技' } })).json;
  acc2 = (await call(accounts.POST, { token: a.token, body: { name: '银河贸易', ownerId: sales.user.id } })).json;
  await add(acc1.id, { name: '张三', title: '采购经理', phone: '021-5555', email: 'zs@xinghe.example', isPrimary: true });
  await add(acc1.id, { name: '李四', title: '工程师' });
  await add(acc2.id, { name: '王五', title: '100%_专员' });
});

describe('contacts list R1', () => {
  it('跨客户列出，最新在前，含所属客户与负责人 / all contacts with their accounts', async () => {
    const r = await list();
    expect(r.total).toBe(3);
    expect(names(r)).toEqual(['王五', '李四', '张三']);
    expect(r.items[0].account).toMatchObject({ id: acc2.id, name: '银河贸易', owner: { id: sales.user.id } });
    expect(r.items[2]).toMatchObject({ isPrimary: true, title: '采购经理', account: { name: '星河科技', owner: { id: a.user.id } } });
  });

  it('按姓名、职位、电话、邮箱、客户名称搜索；通配符按字面匹配 / search fields, literal wildcards', async () => {
    expect(names(await list({ q: '张' }))).toEqual(['张三']);
    expect(names(await list({ q: '工程' }))).toEqual(['李四']);
    expect(names(await list({ q: '5555' }))).toEqual(['张三']);
    expect(names(await list({ q: 'ZS@XINGHE' }))).toEqual(['张三']);
    expect(names(await list({ q: '银河' }))).toEqual(['王五']);
    expect(names(await list({ q: '100%' }))).toEqual(['王五']);
    expect(names(await list({ q: '_' }))).toEqual(['王五']);
    expect((await list({ q: '不存在' })).total).toBe(0);
  });

  it('按客户、负责人（客户负责人）、主要联系人筛选；分页 / filters and paging', async () => {
    expect(names(await list({ accountId: acc1.id }))).toEqual(['李四', '张三']);
    expect(names(await list({ ownerId: sales.user.id }))).toEqual(['王五']);
    expect(names(await list({ isPrimary: 'true' }))).toEqual(['张三']);
    expect(names(await list({ isPrimary: 'false' }))).toEqual(['王五', '李四']);
    expect(names(await list({ accountId: acc1.id, isPrimary: 'false' }))).toEqual(['李四']);
    const p2 = await list({ pageSize: '2', page: '2' });
    expect(p2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(names(p2)).toEqual(['张三']);
  });

  it('详情含所属客户；编辑后列表与详情同步 / detail and edits', async () => {
    const id = (await list({ q: '李四' })).items[0].id;
    const d = await call(contactItem.GET, { token: a.token, params: { id } });
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ name: '李四', account: { id: acc1.id, name: '星河科技' } });
    await call(contactItem.PATCH, { token: a.token, params: { id }, body: { isPrimary: true, phone: '138' }, method: 'PATCH' });
    expect(names(await list({ accountId: acc1.id, isPrimary: 'true' }))).toEqual(['李四']);
    expect((await call(contactItem.GET, { token: a.token, params: { id } })).json).toMatchObject({ phone: '138', isPrimary: true });
  });

  it('导出 CSV：与筛选一致、表头与内容、审计 / export', async () => {
    const url = new URL('http://localhost/api/contacts/export');
    url.searchParams.set('accountId', acc1.id);
    const res = await contactExport.GET(new Request(url, { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Export-Count')).toBe('2');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="contacts-\d{8}\.csv"$/);
    const rows = parseCsv((await res.text()).replace(/^﻿/, ''));
    expect(rows[0]!.slice(0, 7)).toEqual(['姓名', '职位', '电话', '邮箱', '主要联系人', '所属客户', '负责人']);
    expect(rows[0]![7]).toContain('创建时间');
    expect(rows[0]).toHaveLength(8);
    expect(rows.slice(1).map((r) => r.slice(0, 7))).toEqual([
      ['李四', '工程师', '', '', '否', '星河科技', a.user.name],
      ['张三', '采购经理', '021-5555', 'zs@xinghe.example', '是', '星河科技', a.user.name],
    ]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'contact.export' } });
    expect(log.changes).toMatchObject({ count: 2, truncated: false, searched: false, filters: { accountId: acc1.id } });
  });
});
