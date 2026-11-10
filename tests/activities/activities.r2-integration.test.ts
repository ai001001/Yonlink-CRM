/**
 * 跟进 第二轮：集成测试（关联校验、级联、异常输入、边界、组织隔离）。
 * Activities round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as collection from '@/app/api/activities/route';
import * as item from '@/app/api/activities/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
const ZERO = '00000000-0000-4000-8000-000000000000';
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

const mk = (token: string, body: object) => call(collection.POST, { token, body });

describe('activities R2 relations', () => {
  it.each([['accountId'], ['leadId'], ['dealId']])('关联不存在的 %s → 400', async (field) => {
    const res = await mk(a.token, { type: 'CALL', subject: 'x', [field]: ZERO });
    expect(res.status).toBe(400);
    expect(res.json.error.details[field]).toBeDefined();
  });

  it('多个关联同时非法时返回全部字段错误 / reports every bad relation', async () => {
    const res = await mk(a.token, { type: 'CALL', subject: 'x', accountId: ZERO, leadId: ZERO, dealId: ZERO });
    expect(Object.keys(res.json.error.details).sort()).toEqual(['accountId', 'dealId', 'leadId']);
  });

  it('删除线索只级联仅关联该线索的跟进 / lead deletion cascades lead-only activities', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const lead = (await call(leads.POST, { token: a.token, body: { name: '线索' } })).json;
    await mk(a.token, { type: 'CALL', subject: '仅线索', leadId: lead.id });
    await mk(a.token, { type: 'CALL', subject: '仅客户', accountId: acc.id });
    await call(leadItem.DELETE, { token: a.token, method: 'DELETE', params: { id: lead.id } });
    expect((await prisma.activity.findMany()).map((x) => x.subject)).toEqual(['仅客户']);
  });

  it('删除线索/商机时，同时关联其他对象的跟进保留并解除该关联 / shared activities survive deletion and are unlinked', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const lead = (await call(leads.POST, { token: a.token, body: { name: '线索' } })).json;
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id } })).json;
    const shared = (await mk(a.token, { type: 'MEETING', subject: '客户+线索+商机', accountId: acc.id, leadId: lead.id, dealId: deal.id })).json;
    const leadAndDeal = (await mk(a.token, { type: 'CALL', subject: '线索+商机', leadId: lead.id, dealId: deal.id })).json;
    await call(leadItem.DELETE, { token: a.token, method: 'DELETE', params: { id: lead.id } });
    let rows = await prisma.activity.findMany({ orderBy: { subject: 'asc' } });
    // 两条记录都还关联着商机，因此保留，仅解除线索关联 / both rows still reference the deal, so they stay with leadId cleared
    expect(rows.map((r) => [r.subject, r.leadId, r.dealId])).toEqual([
      ['客户+线索+商机', null, deal.id],
      ['线索+商机', null, deal.id],
    ]);
    expect(rows.map((r) => r.id).sort()).toEqual([shared.id, leadAndDeal.id].sort());
    await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: deal.id } });
    rows = await prisma.activity.findMany();
    // 仅关联商机（线索已解除）的记录随商机删除；关联客户的保留 / deal-only rows go, account-linked row stays
    expect(rows.map((r) => [r.subject, r.accountId, r.leadId, r.dealId])).toEqual([['客户+线索+商机', acc.id, null, null]]);
  });

  it('不关联任何对象的独立任务允许保存 / standalone task without relations is allowed', async () => {
    expect((await mk(a.token, { type: 'TASK', subject: '整理周报' })).status).toBe(201);
  });

  it('数据库 CHECK 保证完成状态与完成时间一致 / DB CHECK keeps completed and completedAt consistent', async () => {
    await expect(
      prisma.activity.create({ data: { organizationId: a.org.id, type: 'TASK', subject: 'x', completed: true, completedAt: null } }),
    ).rejects.toThrow();
    await expect(
      prisma.activity.create({ data: { organizationId: a.org.id, type: 'TASK', subject: 'x', completed: false, completedAt: new Date() } }),
    ).rejects.toThrow();
  });
});

describe('activities R2 invalid input & boundaries', () => {
  it.each([
    [{ subject: 'x' }],
    [{ type: 'EMAIL', subject: 'x' }],
    [{ type: 'CALL' }],
    [{ type: 'CALL', subject: ' ' }],
    [{ type: 'CALL', subject: 'x'.repeat(201) }],
    [{ type: 'CALL', subject: 'x', content: 'x'.repeat(10001) }],
    [{ type: 'CALL', subject: 'x', dueAt: '2027-01-01' }],
    [{ type: 'CALL', subject: 'x', dueAt: '2027-01-01T10:00:00' }],
    [{ type: 'CALL', subject: 'x', dueAt: 'not-a-date' }],
    [{ type: 'CALL', subject: 'x', completed: 'yes' }],
    [{ type: 'CALL', subject: 'x', completedAt: '2027-01-01T00:00:00Z' }],
    [{ type: 'CALL', subject: 'x', organizationId: ZERO }],
  ])('非法输入 %j → 400', async (body) => {
    expect((await mk(a.token, body)).status).toBe(400);
    expect(await prisma.activity.count()).toBe(0);
  });

  it('主题 200 字、内容 10000 字边界可保存 / length boundaries accepted', async () => {
    expect((await mk(a.token, { type: 'CALL', subject: '主'.repeat(200), content: '内'.repeat(10000) })).status).toBe(201);
  });

  it('更新时不可清空类型/主题 / type and subject cannot be cleared', async () => {
    const x = (await mk(a.token, { type: 'CALL', subject: 'x' })).json;
    for (const body of [{ type: null }, { subject: '' }, { completed: null }]) {
      expect((await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: x.id }, body })).status).toBe(400);
    }
  });

  it.each([[{ type: 'X' }], [{ completed: '1' }], [{ sort: 'subject' }], [{ dealId: 'abc' }]])('非法查询 %j → 400', async (query) => {
    expect((await call(collection.GET, { token: a.token, query })).status).toBe(400);
  });
});

describe('activities R2 organization isolation', () => {
  it('列表与筛选只含本组织 / list scoped', async () => {
    await mk(a.token, { type: 'CALL', subject: '共同主题' });
    await mk(b.token, { type: 'CALL', subject: '共同主题' });
    expect((await call(collection.GET, { token: a.token, query: { q: '共同' } })).json.total).toBe(1);
  });

  it('跨组织读/改/删跟进 → 404 且数据不变 / IDOR on activities', async () => {
    const x = (await mk(b.token, { type: 'TASK', subject: 'B 任务' })).json;
    expect((await call(item.GET, { token: a.token, params: { id: x.id } })).status).toBe(404);
    expect((await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: x.id }, body: { completed: true } })).status).toBe(404);
    expect((await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: x.id } })).status).toBe(404);
    expect((await prisma.activity.findUniqueOrThrow({ where: { id: x.id } })).completed).toBe(false);
  });

  it('不能通过更新把跟进挂到其他组织的客户/线索/商机 / cannot relink to another org on update', async () => {
    const accB = (await call(accounts.POST, { token: b.token, body: { name: 'B' } })).json;
    const leadB = (await call(leads.POST, { token: b.token, body: { name: 'B' } })).json;
    const dealB = (await call(deals.POST, { token: b.token, body: { name: 'B', accountId: accB.id } })).json;
    const x = (await mk(a.token, { type: 'CALL', subject: 'x' })).json;
    for (const body of [{ accountId: accB.id }, { leadId: leadB.id }, { dealId: dealB.id }]) {
      expect((await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: x.id }, body })).status).toBe(400);
    }
    const row = await prisma.activity.findUniqueOrThrow({ where: { id: x.id } });
    expect([row.accountId, row.leadId, row.dealId]).toEqual([null, null, null]);
  });

  it('不能把负责人设为其他组织用户 / owner from another org rejected', async () => {
    expect((await mk(a.token, { type: 'CALL', subject: 'x', ownerId: b.user.id })).status).toBe(400);
  });

  it('数据库复合外键阻止跨组织关联 / composite FKs block cross-org links', async () => {
    const leadB = (await call(leads.POST, { token: b.token, body: { name: 'B' } })).json;
    await expect(
      prisma.activity.create({ data: { organizationId: a.org.id, type: 'CALL', subject: '绕过', leadId: leadB.id } }),
    ).rejects.toThrow();
  });
});
