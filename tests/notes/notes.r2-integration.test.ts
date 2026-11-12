/**
 * 备注 第二轮：集成测试（角色权限、作者规则、可见范围变化、组织隔离、异常输入、数据库约束、线索转化）。
 * Notes round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as notes from '@/app/api/notes/route';
import * as noteItem from '@/app/api/notes/[id]/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let lead1: { id: string };
beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  lead1 = (await call(leads.POST, { token: sales1.token, body: { name: '销售1的线索' } })).json;
});

const add = (who: Who, body: object) => call(notes.POST, { token: who.token, body });
const list = (who: Who, query: Record<string, string>) => call(notes.GET, { token: who.token, query });

describe('notes R2 permissions', () => {
  it('销售代表可给自己的记录加备注；他人记录不可见（404）/ sales: own records only', async () => {
    expect((await add(sales1, { content: '自己的', leadId: lead1.id })).status).toBe(201);
    expect((await add(sales2, { content: '越权', leadId: lead1.id })).status).toBe(404);
    expect((await list(sales2, { leadId: lead1.id })).status).toBe(404);
  });

  it('只读用户可查看，不能新增（403）/ read-only users read but cannot add', async () => {
    await add(sales1, { content: 'x', leadId: lead1.id });
    expect((await list(viewer, { leadId: lead1.id })).json.items).toHaveLength(1);
    expect((await add(viewer, { content: 'y', leadId: lead1.id })).status).toBe(403);
  });

  it('只有作者能修改，管理员也不行 / only the author edits, not even admins', async () => {
    const n = (await add(sales1, { content: '原文', leadId: lead1.id })).json;
    for (const who of [admin, manager]) {
      expect((await call(noteItem.PATCH, { token: who.token, method: 'PATCH', params: { id: n.id }, body: { content: '篡改' } })).status).toBe(403);
    }
    expect((await prisma.note.findUniqueOrThrow({ where: { id: n.id } })).content).toBe('原文');
  });

  it('删除：作者或有删除权限的角色；销售代表不能删他人在自己记录上的备注 / delete rules', async () => {
    const byManager = (await add(manager, { content: '经理加的', leadId: lead1.id })).json;
    const bySales = (await add(sales1, { content: '销售加的', leadId: lead1.id })).json;
    expect((await call(noteItem.DELETE, { token: sales1.token, method: 'DELETE', params: { id: byManager.id } })).status).toBe(403);
    expect((await call(noteItem.DELETE, { token: viewer.token, method: 'DELETE', params: { id: bySales.id } })).status).toBe(403);
    expect((await call(noteItem.DELETE, { token: sales1.token, method: 'DELETE', params: { id: bySales.id } })).status).toBe(204);
    expect((await call(noteItem.DELETE, { token: admin.token, method: 'DELETE', params: { id: byManager.id } })).status).toBe(204);
    expect(await prisma.note.count()).toBe(0);
  });

  it('记录被改派后，原负责人看不到其备注 / reassignment hides notes from the former owner', async () => {
    const n = (await add(sales1, { content: '我的备注', leadId: lead1.id })).json;
    await call(leadItem.PATCH, { token: manager.token, method: 'PATCH', params: { id: lead1.id }, body: { ownerId: sales2.user.id } });
    expect((await list(sales1, { leadId: lead1.id })).status).toBe(404);
    expect((await call(noteItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: n.id }, body: { content: 'x' } })).status).toBe(404);
    expect((await list(sales2, { leadId: lead1.id })).json.items).toHaveLength(1);
  });

  it('线索转化后备注保留在线索上 / notes stay on the lead after conversion', async () => {
    await add(sales1, { content: '转化前的备注', leadId: lead1.id });
    expect((await call(convert.POST, { token: sales1.token, params: { id: lead1.id }, body: { account: { mode: 'new' } } })).status).toBe(200);
    expect((await list(sales1, { leadId: lead1.id })).json.items.map((n: { content: string }) => n.content)).toEqual(['转化前的备注']);
  });
});

describe('notes R2 isolation & input', () => {
  it('其他组织不可见、不可写、不可改删 / other organizations are isolated', async () => {
    const other = await createTenant('B', 'ADMIN');
    const n = (await add(sales1, { content: '机密', leadId: lead1.id })).json;
    expect((await list(other, { leadId: lead1.id })).status).toBe(404);
    expect((await add(other, { content: 'x', leadId: lead1.id })).status).toBe(404);
    expect((await call(noteItem.PATCH, { token: other.token, method: 'PATCH', params: { id: n.id }, body: { content: 'x' } })).status).toBe(404);
    expect((await call(noteItem.DELETE, { token: other.token, method: 'DELETE', params: { id: n.id } })).status).toBe(404);
  });

  it.each([
    ['空内容 / empty', { content: '' }],
    ['空白 / blank', { content: '   \n ' }],
    ['超长 / too long', { content: 'x'.repeat(5001) }],
    ['未指定所属记录 / no parent', { content: 'x', noParent: true }],
    ['指定两个所属记录 / two parents', { content: 'x', twoParents: true }],
    ['非 UUID / bad uuid', { content: 'x', leadId: 'abc' }],
    ['注入作者 / authorId injection', { content: 'x', authorId: '00000000-0000-4000-8000-000000000000' }],
  ])('非法新增：%s → 400', async (_l, raw) => {
    const { noParent, twoParents, ...body } = raw as Record<string, unknown>;
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    const payload = noParent ? body : twoParents ? { ...body, leadId: lead1.id, accountId: acc.id } : { leadId: lead1.id, ...body };
    expect((await add(admin, payload)).status).toBe(400);
    expect(await prisma.note.count()).toBe(0);
  });

  it('5000 字边界可保存 / exactly 5000 characters are accepted', async () => {
    expect((await add(admin, { content: '备'.repeat(5000), leadId: lead1.id })).status).toBe(201);
  });

  it.each([[{}], [{ leadId: 'x' }], [{ leadId: '00000000-0000-4000-8000-000000000000', dealId: '00000000-0000-4000-8000-000000000001' }]])(
    '非法列表查询 %j → 400 / bad list query',
    async (query) => {
      expect((await list(admin, query as Record<string, string>)).status).toBe(400);
    },
  );

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(notes.GET, { query: { leadId: lead1.id } })).status).toBe(401);
    expect((await call(notes.POST, { body: { content: 'x', leadId: lead1.id } })).status).toBe(401);
  });

  it('含 HTML/脚本的内容按原文保存（显示时按纯文本）/ HTML is stored verbatim (rendered as text)', async () => {
    const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    expect((await add(admin, { content: html, leadId: lead1.id })).json.content).toBe(html);
  });

  it('数据库约束：恰好一个所属记录、内容非空、复合外键防跨组织 / DB constraints', async () => {
    const other = await createTenant('B', 'ADMIN');
    const base = { organizationId: admin.org.id, authorId: admin.user.id, content: 'x' };
    await expect(prisma.note.create({ data: base })).rejects.toThrow();
    const acc = await prisma.account.create({ data: { organizationId: admin.org.id, name: 'c' } });
    await expect(prisma.note.create({ data: { ...base, leadId: lead1.id, accountId: acc.id } })).rejects.toThrow();
    await expect(prisma.note.create({ data: { ...base, content: '   ', leadId: lead1.id } })).rejects.toThrow();
    await expect(prisma.note.create({ data: { ...base, authorId: other.user.id, leadId: lead1.id } })).rejects.toThrow();
    const otherLead = await prisma.lead.create({ data: { organizationId: other.org.id, name: 'B' } });
    await expect(prisma.note.create({ data: { ...base, leadId: otherLead.id } })).rejects.toThrow();
  });
});
