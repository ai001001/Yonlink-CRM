/**
 * 商机竞争对手与联系人角色 第一轮：功能测试（角色新增/重复/他客户联系人/主要联系人切换/修改/移除与审计；
 * 商机换客户移除旧角色、删除联系人级联；竞争对手新增/同名不区分大小写/修改审计脱敏/威胁排序/删除；
 * 回收站快照与恢复；报表竞争对手胜负与导出；演示数据）。
 * Deal competitors and contact roles round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_COMPETITORS, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accounts from '@/app/api/accounts/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as competitorItem from '@/app/api/deal-competitors/[id]/route';
import * as roleItem from '@/app/api/deal-contact-roles/[id]/route';
import * as dealCompetitors from '@/app/api/deals/[id]/competitors/route';
import * as dealRoles from '@/app/api/deals/[id]/contact-roles/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as salesExport from '@/app/api/reports/sales/export/route';
import * as sales from '@/app/api/reports/sales/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
let deal: { id: string };
let c1: { id: string };
let c2: { id: string };
let c3: { id: string };
const today = new Date().toISOString().slice(0, 10);

const contact = async (accountId: string, name: string) => (await call(accountContacts.POST, { token: a.token, params: { id: accountId }, body: { name } })).json;
const addRole = (body: object, dealId = deal.id) => call(dealRoles.POST, { token: a.token, params: { id: dealId }, body });
const roles = async (dealId = deal.id) => (await call(dealRoles.GET, { token: a.token, params: { id: dealId } })).json;
const addCompetitor = (body: object, dealId = deal.id) => call(dealCompetitors.POST, { token: a.token, params: { id: dealId }, body });
const auditOf = (action: string) => prisma.auditLog.findMany({ where: { action, entityId: deal.id }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '甲客户' } })).json;
  deal = (await call(deals.POST, { token: a.token, body: { name: '甲商机', accountId: acc.id, amount: '1000' } })).json;
  c1 = await contact(acc.id, '张总');
  c2 = await contact(acc.id, '李工');
  c3 = await contact(acc.id, '王采购');
});

describe('deal contact roles R1', () => {
  it('新增、候选联系人、重复与他客户联系人、审计 / add, candidates, rules, audit', async () => {
    let r = await addRole({ contactId: c1.id, role: 'DECISION_MAKER', isPrimary: true });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ role: 'DECISION_MAKER', isPrimary: true, contact: { id: c1.id, name: '张总' } });
    const list = await roles();
    expect(list.roles.map((x: { contactId: string }) => x.contactId)).toEqual([c1.id]);
    // 候选只含未分配角色的联系人 / candidates exclude contacts that already have a role
    expect(list.contacts.map((x: { id: string }) => x.id).sort()).toEqual([c2.id, c3.id].sort());
    r = await addRole({ contactId: c1.id, role: 'EVALUATOR' });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ contactId: ['duplicate'] });
    const otherAcc = (await call(accounts.POST, { token: a.token, body: { name: '乙客户' } })).json;
    const stranger = await contact(otherAcc.id, '外人');
    r = await addRole({ contactId: stranger.id, role: 'OTHER' });
    expect(r.status).toBe(400);
    expect(r.json.error.details).toEqual({ contactId: ['other_account'] });
    expect((await addRole({ contactId: '00000000-0000-4000-8000-000000000000', role: 'OTHER' })).json.error.details).toEqual({ contactId: ['not_found'] });
    expect((await addRole({ contactId: c2.id, role: 'BOSS' })).status).toBe(400);
    const logs = await auditOf('deal.add_contact_role');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.changes).toEqual({ contact: '张总', contactRole: 'DECISION_MAKER', isPrimary: true });
  });

  it('主要联系人唯一、修改角色、移除 / primary, update, remove', async () => {
    const r1 = (await addRole({ contactId: c1.id, role: 'DECISION_MAKER', isPrimary: true })).json;
    const r2 = (await addRole({ contactId: c2.id, role: 'EVALUATOR', isPrimary: true })).json;
    // 新的主要联系人取消旧的 / a new primary clears the old one
    expect((await roles()).roles.map((x: { id: string; isPrimary: boolean }) => [x.id, x.isPrimary])).toEqual([
      [r2.id, true],
      [r1.id, false],
    ]);
    let up = await call(roleItem.PATCH, { token: a.token, params: { id: r1.id }, body: { role: 'INFLUENCER', isPrimary: true }, method: 'PATCH' });
    expect(up.json).toMatchObject({ role: 'INFLUENCER', isPrimary: true });
    expect(await prisma.dealContactRole.count({ where: { dealId: deal.id, isPrimary: true } })).toBe(1);
    up = await call(roleItem.PATCH, { token: a.token, params: { id: r1.id }, body: {}, method: 'PATCH' });
    expect(up.status).toBe(400);
    // 不能换联系人 / the contact cannot change
    expect((await call(roleItem.PATCH, { token: a.token, params: { id: r1.id }, body: { contactId: c3.id }, method: 'PATCH' })).status).toBe(400);
    const logs = await auditOf('deal.update_contact_role');
    expect(logs[0]!.changes).toEqual({ contact: '张总', fields: { contactRole: ['DECISION_MAKER', 'INFLUENCER'], isPrimary: [false, true] } });
    expect((await call(roleItem.DELETE, { token: a.token, params: { id: r2.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(roleItem.DELETE, { token: a.token, params: { id: r2.id }, method: 'DELETE' })).status).toBe(404);
    // 联系人本身保留 / the contact is kept
    expect(await prisma.contact.count({ where: { id: c2.id } })).toBe(1);
    expect((await auditOf('deal.remove_contact_role'))[0]!.changes).toEqual({ contact: '李工', contactRole: 'EVALUATOR' });
  });

  it('商机换客户移除旧客户联系人的角色；删除联系人级联 / account change and contact delete', async () => {
    await addRole({ contactId: c1.id, role: 'DECISION_MAKER' });
    await addRole({ contactId: c2.id, role: 'EVALUATOR' });
    expect((await call(contactItem.DELETE, { token: a.token, params: { id: c2.id }, method: 'DELETE' })).status).toBe(204);
    expect((await roles()).roles).toHaveLength(1);
    const acc2 = (await call(accounts.POST, { token: a.token, body: { name: '新客户' } })).json;
    // 只改其他字段不影响角色 / unrelated edits keep roles
    await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { amount: '2000' }, method: 'PATCH' });
    expect((await roles()).roles).toHaveLength(1);
    const r = await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { accountId: acc2.id }, method: 'PATCH' });
    expect(r.status).toBe(200);
    const after = await roles();
    expect(after.roles).toEqual([]);
    expect(after.contacts).toEqual([]);
    const logs = await auditOf('deal.remove_contact_role');
    expect(logs.map((l) => l.changes)).toEqual([{ contact: '张总', contactRole: 'DECISION_MAKER', via: 'deal.update' }]);
  });
});

describe('deal competitors R1', () => {
  it('新增、同名（不区分大小写）、威胁排序、校验 / add, duplicate, order, validation', async () => {
    const low = await addCompetitor({ name: ' Acme ', threatLevel: 'LOW', strengths: '便宜' });
    expect(low.status).toBe(201);
    expect(low.json).toMatchObject({ name: 'Acme', threatLevel: 'LOW', strengths: '便宜', weaknesses: null });
    const dup = await addCompetitor({ name: 'ACME' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details).toEqual({ name: ['duplicate'] });
    expect((await addCompetitor({ name: '   ' })).status).toBe(400);
    expect((await addCompetitor({ name: 'x'.repeat(101) })).status).toBe(400);
    expect((await addCompetitor({ name: '对手', threatLevel: 'EXTREME' })).status).toBe(400);
    await addCompetitor({ name: '中等对手' });
    await addCompetitor({ name: '强敌', threatLevel: 'HIGH', weaknesses: '交期长' });
    const list = (await call(dealCompetitors.GET, { token: a.token, params: { id: deal.id } })).json.items;
    expect(list.map((c: { name: string; threatLevel: string }) => [c.name, c.threatLevel])).toEqual([
      ['强敌', 'HIGH'],
      ['中等对手', 'MEDIUM'],
      ['Acme', 'LOW'],
    ]);
    // 另一个商机可以有同名对手 / another deal may list the same name
    const d2 = (await call(deals.POST, { token: a.token, body: { name: '乙商机', accountId: acc.id } })).json;
    expect((await addCompetitor({ name: 'Acme' }, d2.id)).status).toBe(201);
    expect((await auditOf('deal.add_competitor'))[0]!.changes).toEqual({ competitor: 'Acme', threatLevel: 'LOW' });
  });

  it('修改（长文本审计脱敏）、改名冲突、清空、删除 / update, rename conflict, clear, delete', async () => {
    const c = (await addCompetitor({ name: '对手甲', strengths: '机密优势' })).json;
    await addCompetitor({ name: '对手乙' });
    let r = await call(competitorItem.PATCH, { token: a.token, params: { id: c.id }, body: { name: '对手丙', threatLevel: 'HIGH', strengths: '新的机密' }, method: 'PATCH' });
    expect(r.json).toMatchObject({ name: '对手丙', threatLevel: 'HIGH', strengths: '新的机密' });
    const log = (await auditOf('deal.update_competitor'))[0]!;
    expect(log.changes).toEqual({ competitor: '对手甲', fields: { competitorName: ['对手甲', '对手丙'], threatLevel: ['MEDIUM', 'HIGH'], strengths: ['[redacted]', '[redacted]'] } });
    expect(JSON.stringify(log.changes)).not.toContain('机密');
    r = await call(competitorItem.PATCH, { token: a.token, params: { id: c.id }, body: { name: '对手乙' }, method: 'PATCH' });
    expect(r.status).toBe(409);
    r = await call(competitorItem.PATCH, { token: a.token, params: { id: c.id }, body: { strengths: '  ' }, method: 'PATCH' });
    expect(r.json.strengths).toBeNull();
    // 无变化不写审计 / no change, no audit
    await call(competitorItem.PATCH, { token: a.token, params: { id: c.id }, body: { threatLevel: 'HIGH' }, method: 'PATCH' });
    expect(await auditOf('deal.update_competitor')).toHaveLength(2);
    expect((await call(competitorItem.DELETE, { token: a.token, params: { id: c.id }, method: 'DELETE' })).status).toBe(204);
    expect((await auditOf('deal.remove_competitor'))[0]!.changes).toEqual({ competitor: '对手丙', threatLevel: 'HIGH' });
  });
});

describe('deal competitors & roles R1 recycle, report, demo', () => {
  it('回收站快照与恢复；已删除联系人的角色跳过 / recycle bin snapshot and restore', async () => {
    await addRole({ contactId: c1.id, role: 'DECISION_MAKER', isPrimary: true });
    await addRole({ contactId: c2.id, role: 'EVALUATOR' });
    await addCompetitor({ name: '对手甲', threatLevel: 'HIGH', strengths: '价格' });
    expect((await call(dealItem.DELETE, { token: a.token, params: { id: deal.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.dealContactRole.count()).toBe(0);
    expect(await prisma.dealCompetitor.count()).toBe(0);
    const item = await prisma.recycleBinItem.findFirstOrThrow({ where: { entityId: deal.id } });
    expect(item.summary).toMatchObject({ contactRoles: 2, competitors: 1 });
    // 商机在回收站期间删除一个联系人 / a contact is deleted while the deal is in the bin
    await call(contactItem.DELETE, { token: a.token, params: { id: c2.id }, method: 'DELETE' });
    const r = await call(restore.POST, { token: a.token, params: { id: item.id } });
    expect(r.status).toBe(200);
    expect(r.json.skipped).toEqual(['contactRoles']);
    const back = await roles();
    expect(back.roles.map((x: { contactId: string; role: string; isPrimary: boolean }) => [x.contactId, x.role, x.isPrimary])).toEqual([[c1.id, 'DECISION_MAKER', true]]);
    const comps = (await call(dealCompetitors.GET, { token: a.token, params: { id: deal.id } })).json.items;
    expect(comps).toMatchObject([{ name: '对手甲', threatLevel: 'HIGH', strengths: '价格' }]);
  });

  it('报表：竞争对手胜负（名称合并、币种筛选）与导出 / report win/loss and export', async () => {
    const mk = async (name: string, amount: string, stage: string, currency = 'CNY') =>
      (await call(deals.POST, { token: a.token, body: { name, accountId: acc.id, amount, stage, currency, expectedCloseDate: today } })).json;
    const won = await mk('赢单', '100', 'CLOSED_WON');
    const lost = await mk('输单', '250.50', 'CLOSED_LOST');
    const open = await mk('在手', '80', 'PROPOSAL');
    const usd = await mk('美元输单', '999', 'CLOSED_LOST', 'USD');
    await addCompetitor({ name: 'Acme' }, won.id);
    await addCompetitor({ name: 'acme' }, lost.id);
    await addCompetitor({ name: 'ACME' }, open.id);
    await addCompetitor({ name: 'Acme' }, usd.id);
    await addCompetitor({ name: '小对手' }, open.id);
    const rep = (await call(sales.GET, { token: a.token, query: { currency: 'CNY' } })).json;
    // 合并后显示最早录入的写法 / the merged row shows the first recorded spelling
    expect(rep.competitors).toEqual([
      { name: 'Acme', openCount: 1, wonCount: 1, lostCount: 1, lostAmount: '250.50', winRate: 50 },
      { name: '小对手', openCount: 1, wonCount: 0, lostCount: 0, lostAmount: '0.00', winRate: null },
    ]);
    expect((await call(sales.GET, { token: a.token, query: { currency: 'USD' } })).json.competitors).toEqual([
      { name: 'Acme', openCount: 0, wonCount: 0, lostCount: 1, lostAmount: '999.00', winRate: 0 },
    ]);
    const url = new URL('http://localhost/api/reports/sales/export?currency=CNY');
    const res = await salesExport.GET(new Request(url, { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    const blocks = (await res.text()).replace(/^﻿/, '').split('\r\n\r\n').map((b) => parseCsv(b));
    const block = blocks.find((b) => b[0]?.[0] === '竞争对手胜负')!;
    expect(block.slice(1)).toEqual([
      ['竞争对手', '进行中', '赢单数', '输单数', '期间输单金额', '赢单率 %'],
      ['Acme', '1', '1', '1', '250.50', '50'],
      ['小对手', '1', '0', '0', '0.00', ''],
    ]);
  });

  it('演示数据：竞争对手与联系人角色 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const names = await prisma.dealCompetitor.findMany({ where: { organizationId: org.id }, distinct: ['name'], select: { name: true } });
    expect(names.map((n) => n.name).sort()).toEqual(DEMO_COMPETITORS.map((c) => c.name).sort());
    const rolesInDemo = await prisma.dealContactRole.findMany({ where: { organizationId: org.id }, include: { deal: { select: { accountId: true } }, contact: { select: { accountId: true } } } });
    expect(rolesInDemo.length).toBeGreaterThan(0);
    // 角色联系人都属于商机客户；每个商机一个主要联系人 / contacts belong to the deal's account; one primary per deal
    for (const r of rolesInDemo) expect(r.contact.accountId).toBe(r.deal.accountId);
    const dealCount = await prisma.deal.count({ where: { organizationId: org.id } });
    expect(rolesInDemo.filter((r) => r.isPrimary)).toHaveLength(dealCount);
  });
});
