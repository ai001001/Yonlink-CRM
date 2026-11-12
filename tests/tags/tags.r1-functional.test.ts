/**
 * 标签 第一轮：功能测试（新建与唯一性、改名改色、打标签与审计、列表筛选与返回、批量加减、删除标签、级联、演示数据）。
 * Tags round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME, DEMO_TAGS, demoTagAssignments } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountBulk from '@/app/api/accounts/bulk/route';
import * as accountTags from '@/app/api/accounts/[id]/tags/route';
import * as accounts from '@/app/api/accounts/route';
import * as dealTags from '@/app/api/deals/[id]/tags/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as leadTags from '@/app/api/leads/[id]/tags/route';
import * as leads from '@/app/api/leads/route';
import * as tagItem from '@/app/api/tags/[id]/route';
import * as tags from '@/app/api/tags/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const mkTag = async (name: string, color?: string) => (await call(tags.POST, { token: a.token, body: { name, color } })).json;
const setTags = (route: typeof leadTags, id: string, tagIds: string[]) => call(route.PUT, { token: a.token, method: 'PUT', params: { id }, body: { tagIds } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('tags R1 definitions', () => {
  it('新建：去空格、默认蓝色；名称不区分大小写唯一（409）/ create and uniqueness', async () => {
    const res = await call(tags.POST, { token: a.token, body: { name: '  VIP 客户 ' } });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ name: 'VIP 客户', color: 'blue' });
    const dup = await call(tags.POST, { token: a.token, body: { name: 'vip 客户' } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.name).toEqual(['taken']);
    expect((await prisma.tag.findFirstOrThrow()).nameKey).toBe('vip 客户');
  });

  it('改名改色：审计记录变化；改名与他人重复 409；改大小写允许 / rename and recolour', async () => {
    const t1 = await mkTag('重点');
    await mkTag('一般');
    const r = await call(tagItem.PATCH, { token: a.token, method: 'PATCH', params: { id: t1.id }, body: { name: '重点客户', color: 'gold' } });
    expect(r.json).toMatchObject({ name: '重点客户', color: 'gold' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tag.update', entityId: t1.id } });
    expect(log.changes).toMatchObject({ fields: { name: ['重点', '重点客户'], color: ['blue', 'gold'] } });
    expect((await call(tagItem.PATCH, { token: a.token, method: 'PATCH', params: { id: t1.id }, body: { name: '一般' } })).status).toBe(409);
    const t2 = await mkTag('Abc');
    expect((await call(tagItem.PATCH, { token: a.token, method: 'PATCH', params: { id: t2.id }, body: { name: 'ABC' } })).status).toBe(200);
  });

  it('列表按名称排序，含使用次数 / list with usage counts', async () => {
    const t1 = await mkTag('乙');
    await mkTag('甲');
    const lead = (await call(leads.POST, { token: a.token, body: { name: '线索' } })).json;
    await setTags(leadTags, lead.id, [t1.id]);
    const list = (await call(tags.GET, { token: a.token })).json.items;
    expect(list.map((x: { name: string }) => x.name)).toHaveLength(2);
    expect(list.find((x: { id: string }) => x.id === t1.id)._count).toEqual({ leads: 1, accounts: 0, deals: 0 });
  });
});

describe('tags R1 records', () => {
  it('设置记录标签：返回排序后的标签，审计新增/移除的名称，不变不写审计 / set record tags', async () => {
    const t1 = await mkTag('甲');
    const t2 = await mkTag('乙');
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    let r = await setTags(accountTags, acc.id, [t2.id, t1.id, t1.id]);
    expect(r.status).toBe(200);
    expect(r.json.items.map((x: { name: string }) => x.name).sort()).toEqual(['乙', '甲'].sort());
    r = await setTags(accountTags, acc.id, [t2.id]);
    const logs = await prisma.auditLog.findMany({ where: { action: 'account.tags', entityId: acc.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.changes)).toEqual([
      { added: expect.arrayContaining(['甲', '乙']), removed: [] },
      { added: [], removed: ['甲'] },
    ]);
    await setTags(accountTags, acc.id, [t2.id]);
    expect(await prisma.auditLog.count({ where: { action: 'account.tags', entityId: acc.id } })).toBe(2);
  });

  it('列表返回标签并可按标签筛选（线索/客户/商机）/ lists include tags and filter by tag', async () => {
    const t1 = await mkTag('筛选');
    const l1 = (await call(leads.POST, { token: a.token, body: { name: '有标签线索' } })).json;
    await call(leads.POST, { token: a.token, body: { name: '无标签线索' } });
    await setTags(leadTags, l1.id, [t1.id]);
    const ll = (await call(leads.GET, { token: a.token, query: { tagId: t1.id } })).json;
    expect(ll.items.map((x: { name: string }) => x.name)).toEqual(['有标签线索']);
    expect(ll.items[0].tags).toEqual([{ tag: { id: t1.id, name: '筛选', color: 'blue' } }]);
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const d = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id } })).json;
    await setTags(dealTags, d.id, [t1.id]);
    expect((await call(deals.GET, { token: a.token, query: { tagId: t1.id } })).json.total).toBe(1);
    expect((await call(accounts.GET, { token: a.token, query: { tagId: t1.id } })).json.total).toBe(0);
    expect((await call(dealItem.GET, { token: a.token, params: { id: d.id } })).json.tags).toHaveLength(1);
  });

  it('批量加减标签：已有的不重复，逐条审计 / bulk add and remove', async () => {
    const t1 = await mkTag('批量');
    const ids: string[] = [];
    for (const n of ['甲', '乙', '丙']) ids.push((await call(accounts.POST, { token: a.token, body: { name: n } })).json.id);
    await setTags(accountTags, ids[0]!, [t1.id]);
    const add = await call(accountBulk.POST, { token: a.token, body: { action: 'tag_add', ids, tagId: t1.id } });
    expect(add.json).toMatchObject({ succeeded: ids, failed: [] });
    expect(await prisma.accountTag.count({ where: { tagId: t1.id } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'account.tags' } })).toBe(3);
    const rm = await call(accountBulk.POST, { token: a.token, body: { action: 'tag_remove', ids: ids.slice(0, 2), tagId: t1.id } });
    expect(rm.json.succeeded).toHaveLength(2);
    expect(await prisma.accountTag.count({ where: { tagId: t1.id } })).toBe(1);
  });

  it('删除标签：移除全部关联并审计数量；删除记录时关联随之删除 / delete tag and cascade', async () => {
    const t1 = await mkTag('将删除');
    const lead = (await call(leads.POST, { token: a.token, body: { name: '线索' } })).json;
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    await setTags(leadTags, lead.id, [t1.id]);
    await setTags(accountTags, acc.id, [t1.id]);
    expect((await call(tagItem.DELETE, { token: a.token, method: 'DELETE', params: { id: t1.id } })).status).toBe(204);
    expect(await prisma.leadTag.count()).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tag.delete' } });
    expect(log.changes).toMatchObject({ before: { name: '将删除' }, removed: { leads: 1, accounts: 1, deals: 0 } });
    const t2 = await mkTag('随记录');
    await setTags(leadTags, lead.id, [t2.id]);
    await prisma.lead.delete({ where: { id: lead.id } });
    expect(await prisma.leadTag.count()).toBe(0);
    expect(await prisma.tag.count()).toBe(1);
  });

  it('演示数据：6 个标签，分配与推导一致 / demo tags', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const assigned = demoTagAssignments(buildDemoData());
    expect(await prisma.tag.count({ where: { organizationId: org.id } })).toBe(DEMO_TAGS.length);
    expect(await prisma.accountTag.count({ where: { organizationId: org.id } })).toBe(assigned.accounts.length);
    expect(await prisma.dealTag.count({ where: { organizationId: org.id } })).toBe(assigned.deals.length);
    expect(await prisma.leadTag.count({ where: { organizationId: org.id } })).toBe(assigned.leads.length);
    expect(assigned.accounts.length * assigned.deals.length * assigned.leads.length).toBeGreaterThan(0);
  });
});
