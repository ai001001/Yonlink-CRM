/**
 * 批量操作 第二轮：集成测试（角色权限、部分成功与失败原因、业务规则、组织隔离、异常输入、边界）。
 * Bulk actions round 2: integration tests (role permissions, partial success with reasons, business rules,
 * organization isolation, invalid input, limits).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountBulk from '@/app/api/accounts/bulk/route';
import * as activityBulk from '@/app/api/activities/bulk/route';
import * as deals from '@/app/api/deals/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as leads from '@/app/api/leads/route';
import * as leadBulk from '@/app/api/leads/bulk/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
});

const mkLead = async (who: Who, name: string) => (await call(leads.POST, { token: who.token, body: { name } })).json;
const bulk = (who: Who, body: object) => call(leadBulk.POST, { token: who.token, body });

describe('bulk R2 permissions', () => {
  it('销售代表：可批量改自己线索的状态；他人线索返回 NOT_FOUND 且不变 / sales: own succeed, others not found', async () => {
    const own = await mkLead(sales1, '自己的');
    const others = await mkLead(sales2, '别人的');
    const res = await bulk(sales1, { action: 'status', ids: [own.id, others.id], status: 'CONTACTED' });
    expect(res.status).toBe(200);
    expect(res.json.succeeded).toEqual([own.id]);
    expect(res.json.failed).toEqual([{ id: others.id, code: 'NOT_FOUND', message: 'Record not found' }]);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: others.id } })).status).toBe('NEW');
  });

  it('销售代表：批量删除与指派给他人整批 403 / sales: bulk delete and assigning to others are rejected', async () => {
    const own = await mkLead(sales1, '自己的');
    expect((await bulk(sales1, { action: 'delete', ids: [own.id] })).status).toBe(403);
    expect((await bulk(sales1, { action: 'assign', ids: [own.id], ownerId: sales2.user.id })).status).toBe(403);
    expect((await bulk(sales1, { action: 'assign', ids: [own.id], ownerId: null })).status).toBe(403);
    expect(await prisma.lead.count()).toBe(1);
  });

  it('只读用户：批量修改返回逐条 FORBIDDEN，批量删除整批 403 / read-only: forbidden per record, delete 403', async () => {
    const l = await mkLead(manager, '经理的');
    const res = await bulk(viewer, { action: 'status', ids: [l.id], status: 'CONTACTED' });
    expect(res.json.failed[0].code).toBe('FORBIDDEN');
    expect((await bulk(viewer, { action: 'delete', ids: [l.id] })).status).toBe(403);
  });

  it('经理：可批量改派他人记录 / managers can reassign anyone', async () => {
    const l1 = await mkLead(sales1, 'a');
    const l2 = await mkLead(sales2, 'b');
    const res = await bulk(manager, { action: 'assign', ids: [l1.id, l2.id], ownerId: sales2.user.id });
    expect(res.json.succeeded).toHaveLength(2);
    expect((await call(leads.GET, { token: sales2.token })).json.total).toBe(2);
    expect((await call(leads.GET, { token: sales1.token })).json.total).toBe(0);
  });
});

describe('bulk R2 business rules & partial success', () => {
  it('已转化线索不能改状态（CONFLICT），其他照常处理 / converted leads conflict, others proceed', async () => {
    const converted = await mkLead(admin, '已转化');
    await call(convert.POST, { token: admin.token, params: { id: converted.id }, body: { account: { mode: 'new' } } });
    const normal = await mkLead(admin, '普通');
    const res = await bulk(admin, { action: 'status', ids: [converted.id, normal.id], status: 'UNQUALIFIED' });
    expect(res.json.succeeded).toEqual([normal.id]);
    expect(res.json.failed).toMatchObject([{ id: converted.id, code: 'CONFLICT' }]);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: converted.id } })).status).toBe('CONVERTED');
  });

  it('有商机的客户不能删除（CONFLICT），无商机的被删除 / accounts with deals are kept', async () => {
    const withDeal = (await call(accounts.POST, { token: admin.token, body: { name: '有商机' } })).json;
    await call(deals.POST, { token: admin.token, body: { name: 'd', accountId: withDeal.id } });
    const empty = (await call(accounts.POST, { token: admin.token, body: { name: '无商机' } })).json;
    const res = await call(accountBulk.POST, { token: admin.token, body: { action: 'delete', ids: [withDeal.id, empty.id] } });
    expect(res.json.succeeded).toEqual([empty.id]);
    expect(res.json.failed).toMatchObject([{ id: withDeal.id, code: 'CONFLICT' }]);
    expect(await prisma.account.count()).toBe(1);
  });

  it('不存在与已删除的 ID 返回 NOT_FOUND；重复删除幂等 / missing ids are NOT_FOUND', async () => {
    const l = await mkLead(admin, 'x');
    const ghost = '00000000-0000-4000-8000-000000000000';
    const first = await bulk(admin, { action: 'delete', ids: [l.id, ghost] });
    expect(first.json.succeeded).toEqual([l.id]);
    expect(first.json.failed).toMatchObject([{ id: ghost, code: 'NOT_FOUND' }]);
    const again = await bulk(admin, { action: 'delete', ids: [l.id] });
    expect(again.json.failed).toMatchObject([{ id: l.id, code: 'NOT_FOUND' }]);
  });

  it('失败的记录不写审计，成功的逐条写 / only successful records are audited', async () => {
    const ok = await mkLead(admin, 'ok');
    const ghost = '00000000-0000-4000-8000-000000000000';
    await bulk(admin, { action: 'status', ids: [ok.id, ghost], status: 'CONTACTED' });
    expect(await prisma.auditLog.count({ where: { action: 'lead.update' } })).toBe(1);
  });
});

describe('bulk R2 isolation & input', () => {
  it('其他组织的记录一律 NOT_FOUND 且不受影响 / other organizations are untouched', async () => {
    const other = await createTenant('B', 'ADMIN');
    const theirs = await mkLead(other, '外部线索');
    const res = await bulk(admin, { action: 'delete', ids: [theirs.id] });
    expect(res.json.failed).toMatchObject([{ id: theirs.id, code: 'NOT_FOUND' }]);
    expect(await prisma.lead.count({ where: { id: theirs.id } })).toBe(1);
  });

  it('不能把记录指派给其他组织或停用的用户（整批 400）/ owner must be an active user of the organization', async () => {
    const other = await createTenant('B', 'ADMIN');
    const l = await mkLead(admin, 'x');
    expect((await bulk(admin, { action: 'assign', ids: [l.id], ownerId: other.user.id })).status).toBe(400);
    await prisma.user.update({ where: { id: sales1.user.id }, data: { isActive: false } });
    expect((await bulk(admin, { action: 'assign', ids: [l.id], ownerId: sales1.user.id })).status).toBe(400);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).ownerId).toBe(admin.user.id);
  });

  it.each([
    ['空 ids / empty ids', { action: 'delete', ids: [] }],
    ['非 UUID / bad uuid', { action: 'delete', ids: ['x'] }],
    ['未知动作 / unknown action', { action: 'archive', ids: ['00000000-0000-4000-8000-000000000000'] }],
    ['状态设为已转化 / CONVERTED status', { action: 'status', ids: ['00000000-0000-4000-8000-000000000000'], status: 'CONVERTED' }],
    ['缺少负责人字段 / missing ownerId', { action: 'assign', ids: ['00000000-0000-4000-8000-000000000000'] }],
    ['多余字段 / extra field', { action: 'delete', ids: ['00000000-0000-4000-8000-000000000000'], organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['线索不支持改阶段 / stage on leads', { action: 'stage', ids: ['00000000-0000-4000-8000-000000000000'], stage: 'PROPOSAL' }],
  ])('%s → 400', async (_l, body) => {
    expect((await bulk(admin, body)).status).toBe(400);
  });

  it('上限 200 条：201 条整批 400，200 条可处理 / limit is 200 records', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await bulk(admin, { action: 'delete', ids: ids(201) })).status).toBe(400);
    const res = await bulk(admin, { action: 'delete', ids: ids(200) });
    expect(res.status).toBe(200);
    expect(res.json.failed).toHaveLength(200);
  });

  it('未登录 401；跟进与商机接口同样校验 / unauthenticated 401 on every bulk endpoint', async () => {
    for (const h of [leadBulk.POST, accountBulk.POST, dealBulk.POST, activityBulk.POST]) {
      expect((await call(h, { body: { action: 'delete', ids: ['00000000-0000-4000-8000-000000000000'] } })).status).toBe(401);
    }
    expect((await call(activityBulk.POST, { token: admin.token, body: { action: 'complete', ids: ['00000000-0000-4000-8000-000000000000'], completed: 'yes' } })).status).toBe(400);
    expect((await call(dealBulk.POST, { token: admin.token, body: { action: 'stage', ids: ['00000000-0000-4000-8000-000000000000'], stage: 'WON' } })).status).toBe(400);
  });
});
