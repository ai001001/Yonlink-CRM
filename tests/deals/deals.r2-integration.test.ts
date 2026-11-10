/**
 * 商机 第二轮：集成测试（关联约束、金额/日期边界、异常输入、组织隔离）。
 * Deals round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as activities from '@/app/api/activities/route';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as collection from '@/app/api/deals/route';
import * as item from '@/app/api/deals/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
let accA: { id: string };
let accB: { id: string };
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
  accA = (await call(accounts.POST, { token: a.token, body: { name: 'A 客户' } })).json;
  accB = (await call(accounts.POST, { token: b.token, body: { name: 'B 客户' } })).json;
});

const mk = (token: string, body: object) => call(collection.POST, { token, body });

describe('deals R2 relations', () => {
  it('必须关联客户 / account is required', async () => {
    const res = await mk(a.token, { name: '无客户' });
    expect(res.status).toBe(400);
    expect(res.json.error.details.accountId).toBeDefined();
  });

  it('关联不存在的客户 → 400 / unknown account → 400', async () => {
    const res = await mk(a.token, { name: 'x', accountId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(400);
  });

  it('有商机时客户不可删，删商机后可删 / account deletable only after its deals are gone', async () => {
    const d = (await mk(a.token, { name: 'x', accountId: accA.id })).json;
    expect((await call(accountItem.DELETE, { token: a.token, method: 'DELETE', params: { id: accA.id } })).status).toBe(409);
    await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: d.id } });
    expect((await call(accountItem.DELETE, { token: a.token, method: 'DELETE', params: { id: accA.id } })).status).toBe(204);
  });

  it('删除商机级联删除其跟进记录，但不影响客户跟进 / deleting a deal cascades its activities only', async () => {
    const d = (await mk(a.token, { name: 'x', accountId: accA.id })).json;
    await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '商机电话', dealId: d.id } });
    await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '客户电话', accountId: accA.id } });
    await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: d.id } });
    expect((await prisma.activity.findMany()).map((x) => x.subject)).toEqual(['客户电话']);
  });
});

describe('deals R2 invalid input & boundaries', () => {
  it.each([
    ['负数 / negative', '-1'],
    ['三位小数 / 3 decimals', '1.234'],
    ['17 位整数 / 17 integer digits', '12345678901234567'],
    ['非数字 / not numeric', 'abc'],
    ['科学计数 / scientific', '1e5'],
    ['空串 / empty', ''],
    ['浮点误差数字 / float artefact', 0.1 + 0.2],
    ['负数字 / negative number', -5],
  ])('非法金额 %s → 400', async (_label, amount) => {
    const res = await mk(a.token, { name: 'x', accountId: accA.id, amount });
    expect(res.status).toBe(400);
    expect(res.json.error.details.amount).toBeDefined();
  });

  it('金额上限 9999999999999999.99 与 0 可保存 / max and zero amounts accepted', async () => {
    const max = await mk(a.token, { name: 'max', accountId: accA.id, amount: '9999999999999999.99' });
    expect(max.status).toBe(201);
    expect(max.json.amount).toBe('9999999999999999.99');
    expect((await mk(a.token, { name: 'zero', accountId: accA.id, amount: '0' })).status).toBe(201);
  });

  it('数据库 CHECK 拒绝负金额（纵深防御）/ DB CHECK rejects negative amounts', async () => {
    await expect(prisma.deal.create({ data: { organizationId: a.org.id, accountId: accA.id, name: 'x', amount: '-1' } })).rejects.toThrow();
  });

  it.each([['2027-02-30'], ['2027-13-01'], ['2027/01/01'], ['2027-1-1'], ['tomorrow']])('非法日期 %s → 400', async (expectedCloseDate) => {
    expect((await mk(a.token, { name: 'x', accountId: accA.id, expectedCloseDate })).status).toBe(400);
  });

  it('闰日有效 / leap day accepted', async () => {
    const res = await mk(a.token, { name: 'x', accountId: accA.id, expectedCloseDate: '2028-02-29' });
    expect(res.status).toBe(201);
    expect(res.json.expectedCloseDate.slice(0, 10)).toBe('2028-02-29');
  });

  it.each([
    [{ stage: 'WON' }],
    [{ currency: 'GBP' }],
    [{ name: '' }],
    [{ name: 'x'.repeat(201) }],
    [{ organizationId: '00000000-0000-4000-8000-000000000000' }],
  ])('非法字段 %j → 400', async (extra) => {
    expect((await mk(a.token, { name: 'x', accountId: accA.id, ...extra })).status).toBe(400);
  });

  it('更新时不允许把必填字段清空 / required fields cannot be cleared on update', async () => {
    const d = (await mk(a.token, { name: 'x', accountId: accA.id, amount: '10' })).json;
    for (const body of [{ name: '' }, { accountId: null }, { amount: null }, { stage: null }]) {
      expect((await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: d.id }, body })).status).toBe(400);
    }
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).amount.toString()).toBe('10');
  });
});

describe('deals R2 organization isolation', () => {
  it('不能把商机挂到其他组织客户（新建/更新）/ cannot attach to another org account', async () => {
    expect((await mk(a.token, { name: 'x', accountId: accB.id })).status).toBe(400);
    const d = (await mk(a.token, { name: 'x', accountId: accA.id })).json;
    expect((await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: d.id }, body: { accountId: accB.id } })).status).toBe(400);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).accountId).toBe(accA.id);
  });

  it('跨组织读/改/删商机 → 404 / IDOR on deals', async () => {
    const d = (await mk(b.token, { name: 'B 商机', accountId: accB.id, amount: '500' })).json;
    expect((await call(item.GET, { token: a.token, params: { id: d.id } })).status).toBe(404);
    expect((await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: d.id }, body: { amount: '0' } })).status).toBe(404);
    expect((await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: d.id } })).status).toBe(404);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).amount.toString()).toBe('500');
  });

  it('列表、搜索、金额合计只统计本组织 / list, search and totals are scoped', async () => {
    await mk(a.token, { name: '共同', accountId: accA.id, amount: '100' });
    await mk(b.token, { name: '共同', accountId: accB.id, amount: '900' });
    const res = await call(collection.GET, { token: a.token, query: { q: '共同' } });
    expect(res.json.total).toBe(1);
    expect(res.json.sums).toEqual([{ currency: 'CNY', amount: '100' }]);
    const byOtherAccount = await call(collection.GET, { token: a.token, query: { accountId: accB.id } });
    expect(byOtherAccount.json.total).toBe(0);
  });

  it('不能为其他组织商机建跟进 / cannot attach activity to another org deal', async () => {
    const d = (await mk(b.token, { name: 'B', accountId: accB.id })).json;
    const res = await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: 'x', dealId: d.id } });
    expect(res.status).toBe(400);
    expect(res.json.error.details.dealId).toBeDefined();
  });

  it('数据库复合外键阻止跨组织客户 / composite FK blocks cross-org account', async () => {
    await expect(prisma.deal.create({ data: { organizationId: a.org.id, accountId: accB.id, name: '绕过' } })).rejects.toThrow();
  });
});
