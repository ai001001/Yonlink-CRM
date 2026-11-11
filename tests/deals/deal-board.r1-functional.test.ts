/**
 * 商机看板 第一轮：功能测试（分列、数量、按币种合计、卡片排序、搜索、拖动改阶段）。
 * Deal board round 1: functional tests (columns, counts, per-currency totals, card order, search, stage moves).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as deals from '@/app/api/deals/route';
import * as board from '@/app/api/deals/board/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let accountId: string;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  accountId = (await call(accounts.POST, { token: a.token, body: { name: '星河科技' } })).json.id;
});

const mk = (body: object) => call(deals.POST, { token: a.token, body: { accountId, ...body } });
const get = async (query: Record<string, string> = {}) => (await call(board.GET, { token: a.token, query })).json;
const col = (b: { columns: { stage: string }[] }, stage: string) => b.columns.find((c) => c.stage === stage) as {
  stage: string;
  count: number;
  sums: { currency: string; amount: string }[];
  items: { name: string }[];
  hasMore: boolean;
};

describe('deal board R1', () => {
  it('固定 6 列，顺序与销售阶段一致；空列数量为 0 / six columns in stage order', async () => {
    const b = await get();
    expect(b.columns.map((c: { stage: string }) => c.stage)).toEqual(['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST']);
    for (const c of b.columns) expect(c).toMatchObject({ count: 0, sums: [], items: [], hasMore: false });
  });

  it('商机进入对应阶段列，数量与按币种合计精确 / deals land in their columns with exact per-currency totals', async () => {
    await mk({ name: '甲', stage: 'PROPOSAL', amount: '100.10' });
    await mk({ name: '乙', stage: 'PROPOSAL', amount: '200.20' });
    await mk({ name: '丙', stage: 'PROPOSAL', amount: '50', currency: 'USD' });
    await mk({ name: '丁', stage: 'CLOSED_WON', amount: '999.99' });
    const b = await get();
    expect(col(b, 'PROPOSAL')).toMatchObject({
      count: 3,
      sums: [
        { currency: 'CNY', amount: '300.3' },
        { currency: 'USD', amount: '50' },
      ],
    });
    expect(col(b, 'PROPOSAL').items.map((d) => d.name).sort()).toEqual(['丙', '乙', '甲']);
    expect(col(b, 'CLOSED_WON')).toMatchObject({ count: 1, sums: [{ currency: 'CNY', amount: '999.99' }] });
    expect(col(b, 'QUALIFICATION').count).toBe(0);
  });

  it('卡片按预计成交日期升序，无日期排最后 / cards ordered by expected close date, dateless last', async () => {
    await mk({ name: '无日期' });
    await mk({ name: '较晚', expectedCloseDate: '2027-06-01' });
    await mk({ name: '较早', expectedCloseDate: '2027-01-15' });
    expect(col(await get(), 'QUALIFICATION').items.map((d) => d.name)).toEqual(['较早', '较晚', '无日期']);
  });

  it('卡片包含客户、负责人、金额等展示字段 / cards carry account, owner and amount', async () => {
    await mk({ name: '展示', amount: '88.8', expectedCloseDate: '2027-03-01' });
    const card = col(await get(), 'QUALIFICATION').items[0] as unknown as Record<string, unknown>;
    expect(card).toMatchObject({ name: '展示', amount: '88.8', currency: 'CNY', account: { id: accountId, name: '星河科技' }, owner: { id: a.user.id } });
  });

  it('搜索按商机名或客户名过滤看板 / search filters the board by deal or account name', async () => {
    await mk({ name: '服务器扩容', stage: 'NEGOTIATION' });
    await mk({ name: '办公耗材' });
    const b = await get({ q: '扩容' });
    expect(b.columns.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(1);
    expect(col(b, 'NEGOTIATION').items.map((d) => d.name)).toEqual(['服务器扩容']);
    expect((await get({ q: '星河' })).columns.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(2);
  });

  it('改阶段（拖动）后卡片移到新列，合计随之变化，并写审计 / moving a card updates columns, totals and audit', async () => {
    const d = (await mk({ name: '推进中', amount: '1000' })).json;
    const res = await call(dealItem.PATCH, { token: a.token, method: 'PATCH', params: { id: d.id }, body: { stage: 'NEGOTIATION' } });
    expect(res.status).toBe(200);
    const b = await get();
    expect(col(b, 'QUALIFICATION').count).toBe(0);
    expect(col(b, 'NEGOTIATION')).toMatchObject({ count: 1, sums: [{ currency: 'CNY', amount: '1000' }] });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'deal.update', entityId: d.id } });
    expect(log.changes).toEqual({ fields: { stage: ['QUALIFICATION', 'NEGOTIATION'] } });
  });

  it('每列最多返回 limit 张卡片，数量仍为真实总数并标记 hasMore / per-column limit with true counts', async () => {
    for (let i = 0; i < 5; i++) await mk({ name: `批量${i}` });
    const c = col(await get({ limit: '3' }), 'QUALIFICATION');
    expect(c.items).toHaveLength(3);
    expect(c).toMatchObject({ count: 5, hasMore: true });
    expect(col(await get(), 'QUALIFICATION').hasMore).toBe(false);
  });
});
