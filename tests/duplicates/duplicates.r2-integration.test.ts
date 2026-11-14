/**
 * 查重合并 第二轮：集成测试（角色权限与可见范围、跨组织与不可见记录整体回滚、已转化线索、标签上限、异常输入、并发合并、未登录）。
 * Deduplication round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as merge from '@/app/api/duplicates/merge/route';
import * as duplicates from '@/app/api/duplicates/route';
import * as leadConvert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import * as notes from '@/app/api/notes/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
const lead = async (who: { token: string }, body: object) => (await call(leads.POST, { token: who.token, body })).json as { id: string };
const doMerge = (who: { token: string }, body: object) => call(merge.POST, { token: who.token, body: { entity: 'leads', ...body } });
const groups = async (who: { token: string }, entity = 'leads') => (await call(duplicates.GET, { token: who.token, query: { entity } })).json.groups as { records: { id: string }[] }[];

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('duplicates R2 permissions', () => {
  it('查重遵循可见范围：销售代表看不到与他人记录组成的重复组 / detection follows visibility', async () => {
    await lead(sales1, { name: '甲', email: 'same@a.com' });
    await lead(sales2, { name: '乙', email: 'same@a.com' });
    expect(await groups(sales1)).toEqual([]);
    expect(await groups(viewer)).toHaveLength(1);
    expect(await groups(admin)).toHaveLength(1);
  });

  it('合并需删除权限：销售与只读 403，经理可以 / merging needs delete permission', async () => {
    const m = await lead(sales1, { name: '甲', email: 'x@a.com' });
    const d = await lead(sales1, { name: '甲', email: 'X@a.com' });
    expect((await doMerge(sales1, { masterId: m.id, duplicateIds: [d.id] })).status).toBe(403);
    expect((await doMerge(viewer, { masterId: m.id, duplicateIds: [d.id] })).status).toBe(403);
    expect((await doMerge(manager, { masterId: m.id, duplicateIds: [d.id] })).status).toBe(200);
  });
});

describe('duplicates R2 safety', () => {
  it('跨组织或类型不符的记录：404，整体不变 / foreign or mismatched records roll back', async () => {
    const m = await lead(admin, { name: '主' });
    const d = await lead(admin, { name: '副' });
    await call(notes.POST, { token: admin.token, body: { leadId: d.id, content: '备注' } });
    const other = await createTenant('B', 'ADMIN');
    const foreign = await lead(other, { name: '他组织' });
    expect((await doMerge(admin, { masterId: m.id, duplicateIds: [d.id, foreign.id] })).status).toBe(404);
    const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
    expect((await doMerge(admin, { masterId: m.id, duplicateIds: [acc.id] })).status).toBe(404);
    expect(await prisma.lead.count({ where: { id: d.id } })).toBe(1);
    expect(await prisma.note.count({ where: { leadId: d.id } })).toBe(1);
    expect(await prisma.recycleBinItem.count()).toBe(0);
  });

  it('已转化线索不能合并（409），数据不变 / converted leads are refused', async () => {
    const m = await lead(admin, { name: '主', company: '甲' });
    const d = await lead(admin, { name: '主', company: '甲' });
    await call(leadConvert.POST, { token: admin.token, params: { id: d.id }, body: { account: { mode: 'new' } } });
    const r = await doMerge(admin, { masterId: m.id, duplicateIds: [d.id] });
    expect(r.status).toBe(409);
    expect(r.json.error.details.ids).toEqual(['converted']);
    expect(await prisma.lead.count()).toBe(2);
  });

  it('合并后标签超过 20 个：400，数据不变 / tag limit', async () => {
    const m = await lead(admin, { name: '主' });
    const d = await lead(admin, { name: '副' });
    const tagIds = (await Promise.all(Array.from({ length: 21 }, (_, i) => prisma.tag.create({ data: { organizationId: admin.org.id, name: `t${i}`, nameKey: `t${i}` } })))).map((t) => t.id);
    await prisma.leadTag.createMany({ data: tagIds.slice(0, 15).map((tagId) => ({ organizationId: admin.org.id, leadId: m.id, tagId })) });
    await prisma.leadTag.createMany({ data: tagIds.slice(11, 21).map((tagId) => ({ organizationId: admin.org.id, leadId: d.id, tagId })) });
    const r = await doMerge(admin, { masterId: m.id, duplicateIds: [d.id] });
    expect(r.status).toBe(400);
    expect(r.json.error.details.tags).toEqual(['limit']);
    expect(await prisma.lead.count()).toBe(2);
    expect(await prisma.leadTag.count({ where: { leadId: m.id } })).toBe(15);
  });

  it('并发：同一条重复记录同时合并到两个主记录，只成功一次 / concurrent merges', async () => {
    const m1 = await lead(admin, { name: '主一' });
    const m2 = await lead(admin, { name: '主二' });
    const d = await lead(admin, { name: '副' });
    await call(notes.POST, { token: admin.token, body: { leadId: d.id, content: '只能去一个主记录' } });
    const res = await Promise.all([doMerge(admin, { masterId: m1.id, duplicateIds: [d.id] }), doMerge(manager, { masterId: m2.id, duplicateIds: [d.id] })]);
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.note.count({ where: { leadId: { in: [m1.id, m2.id] } } })).toBe(1);
    expect(await prisma.lead.count({ where: { id: d.id } })).toBe(0);
  });
});

describe('duplicates R2 input', () => {
  it.each([
    [(m: string) => ({ masterId: m, duplicateIds: [m] })],
    [(m: string, d: string) => ({ masterId: m, duplicateIds: [d, d] })],
    [(m: string) => ({ masterId: m, duplicateIds: [] })],
    [(m: string, d: string) => ({ masterId: m, duplicateIds: [d], fields: { createdAt: d } })],
    [(m: string, d: string) => ({ masterId: m, duplicateIds: [d], fields: { name: '00000000-0000-4000-8000-000000000000' } })],
    [(m: string, d: string) => ({ masterId: m, duplicateIds: [d], entity: 'contacts' })],
    [(m: string, d: string) => ({ masterId: m, duplicateIds: [d], organizationId: '00000000-0000-4000-8000-000000000000' })],
    [(m: string) => ({ masterId: m, duplicateIds: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`) })],
  ])('非法合并参数 #%# → 400 / invalid merge input', async (make) => {
    const m = await lead(admin, { name: '主' });
    const d = await lead(admin, { name: '副' });
    expect((await doMerge(admin, make(m.id, d.id))).status).toBe(400);
    expect(await prisma.lead.count()).toBe(2);
  });

  it('非法查重参数与未登录 / invalid query and authentication', async () => {
    expect((await call(duplicates.GET, { token: admin.token, query: { entity: 'deals' } })).status).toBe(400);
    expect((await call(duplicates.GET, { token: admin.token })).status).toBe(400);
    expect((await call(duplicates.GET, { query: { entity: 'leads' } })).status).toBe(401);
    expect((await call(merge.POST, { body: { entity: 'leads', masterId: admin.user.id, duplicateIds: [admin.org.id] } })).status).toBe(401);
  });
});
