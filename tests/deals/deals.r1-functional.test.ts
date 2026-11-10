/**
 * 商机 第一轮：功能测试（新增、编辑、删除、详情、金额、阶段、预计成交日期、关联客户、搜索）。
 * Deals round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as collection from '@/app/api/deals/route';
import * as item from '@/app/api/deals/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string; name: string };
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '深圳海川电子' } })).json;
});

const mk = async (body: object) => call(collection.POST, { token: a.token, body: { accountId: acc.id, ...body } });

describe('deals R1 functional', () => {
  it('新增商机：金额、阶段、预计成交日期、关联客户 / create with amount, stage, close date, account', async () => {
    const res = await mk({ name: '2027 年度采购框架', amount: '1234567.89', stage: 'PROPOSAL', expectedCloseDate: '2027-03-31', description: '年度框架' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      name: '2027 年度采购框架',
      amount: '1234567.89',
      currency: 'CNY',
      stage: 'PROPOSAL',
      accountId: acc.id,
      account: { id: acc.id, name: '深圳海川电子' },
      ownerId: a.user.id,
    });
    expect(res.json.expectedCloseDate.slice(0, 10)).toBe('2027-03-31');
    const row = await prisma.deal.findUniqueOrThrow({ where: { id: res.json.id } });
    expect(row.amount.toString()).toBe('1234567.89');
  });

  it('默认值：金额 0、阶段资格确认、币种 CNY / defaults', async () => {
    const res = await mk({ name: '初步接触' });
    expect(res.json).toMatchObject({ amount: '0', stage: 'QUALIFICATION', currency: 'CNY', expectedCloseDate: null });
  });

  it('金额可用数字提交，精确保存两位小数 / numeric amounts keep exact cents', async () => {
    const res = await mk({ name: '数字金额', amount: 19.99 });
    expect(res.json.amount).toBe('19.99');
  });

  it('查看详情 / get detail', async () => {
    const d = (await mk({ name: '详情商机', amount: '100' })).json;
    const res = await call(item.GET, { token: a.token, params: { id: d.id } });
    expect(res.status).toBe(200);
    expect(res.json.account.name).toBe('深圳海川电子');
  });

  it('编辑商机：推进阶段、改金额、改日期、改关联客户 / update stage, amount, date, account', async () => {
    const acc2 = (await call(accounts.POST, { token: a.token, body: { name: '另一客户' } })).json;
    const d = (await mk({ name: '待推进', amount: '100', expectedCloseDate: '2027-01-01' })).json;
    const res = await call(item.PATCH, {
      token: a.token,
      method: 'PATCH',
      params: { id: d.id },
      body: { stage: 'CLOSED_WON', amount: '250.5', expectedCloseDate: null, accountId: acc2.id },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ stage: 'CLOSED_WON', amount: '250.5', expectedCloseDate: null, account: { name: '另一客户' } });
  });

  it('删除商机 / delete', async () => {
    const d = (await mk({ name: '删除我' })).json;
    expect((await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: d.id } })).status).toBe(204);
    expect(await prisma.deal.count()).toBe(0);
  });

  it('搜索商机名称与客户名称、按阶段与客户筛选 / search name & account name, filter stage & account', async () => {
    await mk({ name: '服务器扩容', stage: 'NEGOTIATION' });
    const acc2 = (await call(accounts.POST, { token: a.token, body: { name: '成都锦城物流' } })).json;
    await call(collection.POST, { token: a.token, body: { name: '仓储系统', accountId: acc2.id } });
    const names = async (query: Record<string, string>) =>
      (await call(collection.GET, { token: a.token, query })).json.items.map((d: { name: string }) => d.name);
    expect(await names({ q: '扩容' })).toEqual(['服务器扩容']);
    expect(await names({ q: '锦城' })).toEqual(['仓储系统']);
    expect(await names({ stage: 'NEGOTIATION' })).toEqual(['服务器扩容']);
    expect(await names({ accountId: acc2.id })).toEqual(['仓储系统']);
  });

  it('列表返回筛选范围内按币种的金额合计（十进制精确）/ list returns exact per-currency totals', async () => {
    await mk({ name: '甲', amount: '0.10' });
    await mk({ name: '乙', amount: '0.20' });
    await mk({ name: '丙', amount: '100', currency: 'USD' });
    await mk({ name: '丁', amount: '999.99', stage: 'CLOSED_LOST' });
    const all = await call(collection.GET, { token: a.token, query: { pageSize: '1' } });
    expect(all.json.items).toHaveLength(1);
    expect(all.json.sums).toEqual([
      { currency: 'CNY', amount: '1000.29' },
      { currency: 'USD', amount: '100' },
    ]);
    const lost = await call(collection.GET, { token: a.token, query: { stage: 'CLOSED_LOST' } });
    expect(lost.json.sums).toEqual([{ currency: 'CNY', amount: '999.99' }]);
  });

  it('分页 / pagination', async () => {
    for (let i = 0; i < 7; i++) await mk({ name: `商机${i}` });
    const p2 = await call(collection.GET, { token: a.token, query: { page: '2', pageSize: '5' } });
    expect(p2.json).toMatchObject({ total: 7, page: 2 });
    expect(p2.json.items).toHaveLength(2);
  });
});
