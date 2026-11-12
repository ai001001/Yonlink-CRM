/**
 * 备注 第一轮：功能测试（三类记录的新增、列表、修改、删除、审计、级联删除、演示数据）。
 * Notes round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as notes from '@/app/api/notes/route';
import * as noteItem from '@/app/api/notes/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

const mkParents = async () => {
  const lead = (await call(leads.POST, { token: a.token, body: { name: '线索' } })).json;
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
  const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id } })).json;
  return { lead, acc, deal };
};

describe('notes R1', () => {
  it('线索、客户、商机都可新增备注，返回作者 / notes can be added to leads, accounts and deals', async () => {
    const { lead, acc, deal } = await mkParents();
    for (const parent of [{ leadId: lead.id }, { accountId: acc.id }, { dealId: deal.id }]) {
      const res = await call(notes.POST, { token: a.token, body: { content: '  客户关注交期  ', ...parent } });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ content: '客户关注交期', authorId: a.user.id, author: { id: a.user.id, name: a.user.name }, ...parent });
    }
    expect(await prisma.note.count()).toBe(3);
  });

  it('列表只返回该记录的备注，最新在前 / list returns the record’s notes, newest first', async () => {
    const { lead, acc } = await mkParents();
    for (const c of ['第一条', '第二条', '第三条']) await call(notes.POST, { token: a.token, body: { content: c, leadId: lead.id } });
    await call(notes.POST, { token: a.token, body: { content: '客户的', accountId: acc.id } });
    const res = await call(notes.GET, { token: a.token, query: { leadId: lead.id } });
    expect(res.json.items.map((n: { content: string }) => n.content)).toEqual(['第三条', '第二条', '第一条']);
  });

  it('作者可修改，内容保留换行 / the author edits and line breaks are kept', async () => {
    const { lead } = await mkParents();
    const n = (await call(notes.POST, { token: a.token, body: { content: '原文', leadId: lead.id } })).json;
    const res = await call(noteItem.PATCH, { token: a.token, method: 'PATCH', params: { id: n.id }, body: { content: '第一行\n第二行' } });
    expect(res.status).toBe(200);
    expect(res.json.content).toBe('第一行\n第二行');
    // 新建时未编辑，修改后记录编辑时间（即使紧接着修改）/ editedAt is null on create and set right after an edit
    expect(n.editedAt).toBeNull();
    expect(res.json.editedAt).not.toBeNull();
  });

  it('删除备注 / delete a note', async () => {
    const { deal } = await mkParents();
    const n = (await call(notes.POST, { token: a.token, body: { content: 'x', dealId: deal.id } })).json;
    expect((await call(noteItem.DELETE, { token: a.token, method: 'DELETE', params: { id: n.id } })).status).toBe(204);
    expect(await prisma.note.count()).toBe(0);
  });

  it('新增/修改/删除都写审计，正文脱敏 / create, update and delete are audited with redacted content', async () => {
    const { lead } = await mkParents();
    const n = (await call(notes.POST, { token: a.token, body: { content: '客户私下说预算 200 万', leadId: lead.id } })).json;
    await call(noteItem.PATCH, { token: a.token, method: 'PATCH', params: { id: n.id }, body: { content: '修改后的机密内容' } });
    await call(noteItem.DELETE, { token: a.token, method: 'DELETE', params: { id: n.id } });
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'note' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['note.create', 'note.update', 'note.delete']);
    expect(logs[0]!.changes).toEqual({ after: { content: '[redacted]', leadId: lead.id, accountId: null, dealId: null } });
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('预算 200 万');
    expect(dump).not.toContain('机密内容');
  });

  it('未修改内容的保存不写审计 / saving unchanged content writes no audit entry', async () => {
    const { lead } = await mkParents();
    const n = (await call(notes.POST, { token: a.token, body: { content: '不变', leadId: lead.id } })).json;
    const res = await call(noteItem.PATCH, { token: a.token, method: 'PATCH', params: { id: n.id }, body: { content: '不变' } });
    expect(await prisma.auditLog.count({ where: { action: 'note.update' } })).toBe(0);
    expect(res.json.editedAt).toBeNull();
  });

  it('删除所属客户时其备注一并删除 / notes are removed with their account', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '待删客户' } })).json;
    await call(notes.POST, { token: a.token, body: { content: 'x', accountId: acc.id } });
    await call(accountItem.DELETE, { token: a.token, method: 'DELETE', params: { id: acc.id } });
    expect(await prisma.note.count()).toBe(0);
  });

  it('演示数据包含备注，作者为记录负责人 / demo data includes notes authored by record owners', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.note.findMany({ where: { organizationId: org.id }, include: { deal: true, account: true } });
    expect(rows).toHaveLength(buildDemoData().notes.length);
    for (const n of rows) {
      expect(n.content.startsWith('【演示】')).toBe(true);
      expect(n.authorId).toBe((n.deal ?? n.account)!.ownerId);
    }
  });
});
