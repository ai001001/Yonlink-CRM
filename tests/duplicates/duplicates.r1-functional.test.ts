/**
 * 查重合并 第一轮：功能测试（匹配键规范化、分组传递、线索与客户分组、合并时相关数据迁移与字段选择、回收站与审计、演示数据）。
 * Deduplication round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as deals from '@/app/api/deals/route';
import * as merge from '@/app/api/duplicates/merge/route';
import * as duplicates from '@/app/api/duplicates/route';
import * as leadConvert from '@/app/api/leads/[id]/convert/route';
import * as leadTags from '@/app/api/leads/[id]/tags/route';
import * as leads from '@/app/api/leads/route';
import * as notes from '@/app/api/notes/route';
import * as restoreRoute from '@/app/api/recycle-bin/[id]/restore/route';
import * as tags from '@/app/api/tags/route';
import { prisma } from '@/server/db';
import { domainKey, groupDuplicates, nameKey, phoneKey } from '@/server/modules/duplicates';
import { upload } from '../attachments/files';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const post = async (route: { POST: Parameters<typeof call>[0] }, body: object, params?: Record<string, string>) => (await call(route.POST, { token: a.token, body, params })).json;
const find = async (entity: string, token = a.token) => (await call(duplicates.GET, { token, query: { entity } })).json;
const doMerge = (body: object, token = a.token) => call(merge.POST, { token, body });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('duplicates R1 keys & grouping', () => {
  it('匹配键：电话只比数字（兼容 +86）、域名去协议/www/路径、名称忽略标点与空白 / normalised keys', () => {
    expect(phoneKey('+86 138-0000-0000')).toBe(phoneKey('13800000000'));
    expect(phoneKey('(021) 5555 0000')).toBe('02155550000');
    expect(phoneKey('12345')).toBeNull();
    expect(domainKey('https://www.Example.com:8080/contact?a=1')).toBe('example.com');
    expect(domainKey('example.com')).toBe('example.com');
    expect(domainKey('localhost')).toBeNull();
    expect(nameKey('【演示】 星河 科技（上海）有限公司!')).toBe(nameKey('【演示】星河科技(上海)有限公司'));
  });

  it('分组可传递：A~B（邮箱）、B~C（电话）归为一组并列出两种依据 / groups are transitive', () => {
    const rows = [
      { id: 'a', email: 'x@a.com', phone: null },
      { id: 'b', email: 'X@a.com ', phone: '13800000000' },
      { id: 'c', email: null, phone: '+86 13800000000' },
      { id: 'd', email: 'other@a.com', phone: null },
    ];
    const groups = groupDuplicates(rows, { email: (r) => r.email?.trim().toLowerCase() ?? null, phone: (r) => phoneKey(r.phone) });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(groups[0]!.reasons).toEqual(['email', 'phone']);
  });

  it('线索分组：邮箱、电话与手机交叉、姓名+公司；按创建时间排序 / lead groups', async () => {
    const l1 = await post(leads, { name: '张三', company: '甲公司', email: 'zs@a.com' });
    const l2 = await post(leads, { name: '张 三', company: '甲 公司', email: 'ZS@A.COM' });
    const l3 = await post(leads, { name: '李四', phone: '021-5555-0000' });
    const l4 = await post(leads, { name: '李四（重复）', mobile: '02155550000' });
    await post(leads, { name: '王五', company: '乙公司' });
    const r = await find('leads');
    expect(r.scanned).toBe(5);
    expect(r.groups).toHaveLength(2);
    const g1 = r.groups.find((g: { records: { id: string }[] }) => g.records[0]!.id === l1.id);
    expect(g1.records.map((x: { id: string }) => x.id)).toEqual([l1.id, l2.id]);
    expect(g1.reasons).toEqual(['email', 'nameCompany']);
    const g2 = r.groups.find((g: { records: { id: string }[] }) => g.records[0]!.id === l3.id);
    expect(g2.records.map((x: { id: string }) => x.id)).toEqual([l3.id, l4.id]);
    expect(g2.reasons).toEqual(['phone']);
  });

  it('客户分组：名称、网站域名、电话 / account groups', async () => {
    const c1 = await post(accounts, { name: '星河科技（上海）', website: 'https://www.xinghe.example' });
    const c2 = await post(accounts, { name: '星河科技(上海) ', phone: '0571-555' });
    const c3 = await post(accounts, { name: '银河贸易', website: 'xinghe.example/about' });
    await post(accounts, { name: '无关客户' });
    const r = await find('accounts');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].records.map((x: { id: string }) => x.id)).toEqual([c1.id, c2.id, c3.id]);
    expect(r.groups[0].reasons).toEqual(['name', 'website']);
  });
});

describe('duplicates R1 merge', () => {
  it('合并线索：备注、跟进、附件、标签转到主记录，字段按选择保留，被合并的进入回收站并审计 / merge leads', async () => {
    const master = await post(leads, { name: '张三', email: 'zs@a.com' });
    const dup = await post(leads, { name: '张三', email: 'ZS@a.com', company: '甲公司', phone: '13800000000' });
    const tag1 = await post(tags, { name: '展会' });
    const tag2 = await post(tags, { name: '重点' });
    await call(leadTags.PUT, { token: a.token, method: 'PUT', params: { id: master.id }, body: { tagIds: [tag1.id] } });
    await call(leadTags.PUT, { token: a.token, method: 'PUT', params: { id: dup.id }, body: { tagIds: [tag1.id, tag2.id] } });
    await post(notes, { leadId: dup.id, content: '重复记录上的备注' });
    await post(activities, { type: 'CALL', subject: '重复记录上的跟进', leadId: dup.id });
    const file = (await upload(a.token, { leadId: dup.id }, '名片.txt', '名片')).json;
    const r = await doMerge({ entity: 'leads', masterId: master.id, duplicateIds: [dup.id], fields: { company: dup.id, phone: dup.id } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ entity: 'leads', masterId: master.id, merged: 1, moved: { notes: 1, activities: 1, attachments: 1, tags: 1 } });
    const m = await prisma.lead.findUniqueOrThrow({ where: { id: master.id }, include: { tags: true, notes: true, activities: true, attachments: true } });
    expect([m.email, m.company, m.phone]).toEqual(['zs@a.com', '甲公司', '13800000000']);
    expect(m.tags.map((t) => t.tagId).sort()).toEqual([tag1.id, tag2.id].sort());
    expect([m.notes.length, m.activities.length, m.attachments[0]?.id]).toEqual([1, 1, file.id]);
    expect(await prisma.lead.count({ where: { id: dup.id } })).toBe(0);
    const item = await prisma.recycleBinItem.findFirstOrThrow({ where: { entityId: dup.id } });
    expect(item.summary).toMatchObject({ notes: 0, activities: 0, attachments: 0 });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.merge', entityId: master.id } });
    expect(log.changes).toMatchObject({ merged: [{ id: dup.id, name: '张三' }], fields: { company: [null, '甲公司'] }, moved: { notes: 1 } });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.delete', entityId: dup.id } })).changes).toMatchObject({ recycled: true, mergedInto: master.id });
  });

  it('合并客户：联系人（保留主客户的主要联系人）、商机、转化来源线索、负责人字段 / merge accounts', async () => {
    const sales = await addUser(a.org.id, 'SALES', '乙');
    const master = await post(accounts, { name: '星河科技' });
    await post(accountContacts, { name: '主联系人', isPrimary: true }, { id: master.id });
    const lead = await post(leads, { name: '来源', company: '星河科技 ' });
    const conv = await post(leadConvert, { account: { mode: 'new' } }, { id: lead.id });
    const dupId = conv.account.id as string;
    await prisma.account.update({ where: { id: dupId }, data: { ownerId: sales.user.id } });
    await post(deals, { name: '重复客户的商机', accountId: dupId });
    const r = await doMerge({ entity: 'accounts', masterId: master.id, duplicateIds: [dupId], fields: { ownerId: dupId } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.moved).toMatchObject({ contacts: 1, deals: 1, conversions: 1 });
    const contacts = await prisma.contact.findMany({ where: { accountId: master.id }, orderBy: { createdAt: 'asc' } });
    expect(contacts.map((c) => [c.name, c.isPrimary])).toEqual([
      ['主联系人', true],
      [conv.contact.name, false],
    ]);
    expect((await prisma.deal.findFirstOrThrow({ where: { name: '重复客户的商机' } })).accountId).toBe(master.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).convertedAccountId).toBe(master.id);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: master.id } })).ownerId).toBe(sales.user.id);
  });

  it('从回收站恢复被合并的记录：只找回记录本身，相关数据仍在主记录 / restoring a merged record', async () => {
    const master = await post(leads, { name: '主' });
    const dup = await post(leads, { name: '副', email: 'f@a.com' });
    await post(notes, { leadId: dup.id, content: '备注' });
    await doMerge({ entity: 'leads', masterId: master.id, duplicateIds: [dup.id] });
    const item = await prisma.recycleBinItem.findFirstOrThrow({ where: { entityId: dup.id } });
    expect((await call(restoreRoute.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: dup.id } })).email).toBe('f@a.com');
    expect(await prisma.note.count({ where: { leadId: master.id } })).toBe(1);
  });

  it('演示数据：重复线索与重复客户能被找到 / demo duplicates are detected', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const { token } = await addUser(org.id, 'READONLY', 'DUPVIEW');
    const l = await find('leads', token);
    expect(l.groups.length).toBeGreaterThanOrEqual(2);
    expect(l.groups.flatMap((g: { reasons: string[] }) => g.reasons)).toEqual(expect.arrayContaining(['email', 'nameCompany']));
    const c = await find('accounts', token);
    expect(c.groups.length).toBeGreaterThanOrEqual(1);
    expect(c.groups[0].reasons).toEqual(expect.arrayContaining(['name', 'website']));
  });
});
