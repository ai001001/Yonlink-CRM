/**
 * 商机看板 第二轮：集成测试（角色可见范围、改阶段权限、组织隔离、异常参数、边界）。
 * Deal board round 2: integration tests (role visibility, stage-change permissions, isolation, bad params, boundaries).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as deals from '@/app/api/deals/route';
import * as board from '@/app/api/deals/board/route';
import * as dealItem from '@/app/api/deals/[id]/route';
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

const total = (b: { columns: { count: number }[] }) => b.columns.reduce((n, c) => n + c.count, 0);
const getBoard = async (who: Who, query: Record<string, string> = {}) => (await call(board.GET, { token: who.token, query })).json;
const mkDeal = async (who: Who, body: object) => {
  const acc = (await call(accounts.POST, { token: who.token, body: { name: `客户${Math.random()}` } })).json;
  return (await call(deals.POST, { token: who.token, body: { accountId: acc.id, ...body } })).json;
};
const patchStage = (who: Who, id: string, stage: string) => call(dealItem.PATCH, { token: who.token, method: 'PATCH', params: { id }, body: { stage } });

describe('deal board R2 visibility & permissions', () => {
  it('销售代表看板只含自己负责的商机，合计也只算自己的 / sales reps see and sum only their own deals', async () => {
    await mkDeal(sales1, { name: '销售1', amount: '100' });
    await mkDeal(sales2, { name: '销售2', amount: '900' });
    const b1 = await getBoard(sales1);
    expect(total(b1)).toBe(1);
    expect(b1.columns[0].sums).toEqual([{ currency: 'CNY', amount: '100' }]);
    expect(total(await getBoard(manager))).toBe(2);
    expect(total(await getBoard(viewer))).toBe(2);
  });

  it('ownerId 筛选无法绕过可见范围 / an ownerId filter cannot bypass visibility', async () => {
    await mkDeal(sales2, { name: '销售2' });
    expect(total(await getBoard(sales1, { ownerId: sales2.user.id }))).toBe(0);
    expect(total(await getBoard(manager, { ownerId: sales2.user.id }))).toBe(1);
  });

  it('改阶段权限：只读 403、销售改他人 404、销售改自己 200、经理改任意 200 / stage change permissions', async () => {
    const own = await mkDeal(sales1, { name: '自己的' });
    const others = await mkDeal(sales2, { name: '别人的' });
    expect((await patchStage(viewer, own.id, 'PROPOSAL')).status).toBe(403);
    expect((await patchStage(sales1, others.id, 'PROPOSAL')).status).toBe(404);
    expect((await patchStage(sales1, own.id, 'PROPOSAL')).status).toBe(200);
    expect((await patchStage(manager, others.id, 'CLOSED_WON')).status).toBe(200);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: others.id } })).stage).toBe('CLOSED_WON');
  });

  it('非法阶段 → 400 且数据不变 / an invalid stage is rejected and nothing changes', async () => {
    const d = await mkDeal(admin, { name: 'x' });
    expect((await patchStage(admin, d.id, 'WON')).status).toBe(400);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).stage).toBe('QUALIFICATION');
  });

  it('未登录 401 / unauthenticated → 401', async () => {
    expect((await call(board.GET)).status).toBe(401);
  });
});

describe('deal board R2 isolation & input', () => {
  it('其他组织商机不出现在看板上 / other organizations never appear', async () => {
    const other = await createTenant('B', 'ADMIN');
    await mkDeal(other, { name: '外部商机', amount: '5000' });
    await mkDeal(admin, { name: '本组织', amount: '1' });
    const b = await getBoard(admin);
    expect(total(b)).toBe(1);
    expect(JSON.stringify(b)).not.toContain('外部商机');
  });

  it.each([[{ limit: '0' }], [{ limit: '201' }], [{ limit: 'abc' }], [{ accountId: 'x' }], [{ ownerId: '1' }], [{ q: 'x'.repeat(101) }]])(
    '非法参数 %j → 400',
    async (query) => {
      expect((await call(board.GET, { token: admin.token, query })).status).toBe(400);
    },
  );

  it('limit 边界 1 与 200 可用 / limit boundaries 1 and 200 work', async () => {
    await mkDeal(admin, { name: 'a' });
    await mkDeal(admin, { name: 'b' });
    const one = await getBoard(admin, { limit: '1' });
    expect(one.columns[0]).toMatchObject({ count: 2, hasMore: true });
    expect(one.columns[0].items).toHaveLength(1);
    expect((await getBoard(admin, { limit: '200' })).columns[0].hasMore).toBe(false);
  });

  it('搜索中的通配符按字面处理 / search wildcards are literal', async () => {
    await mkDeal(admin, { name: '普通商机' });
    expect(total(await getBoard(admin, { q: '%' }))).toBe(0);
  });

  it('按客户筛选 / filter by account', async () => {
    const d = await mkDeal(admin, { name: '指定客户的' });
    await mkDeal(admin, { name: '其他' });
    const b = await getBoard(admin, { accountId: d.accountId });
    expect(total(b)).toBe(1);
  });
});
