/**
 * 商机阶段历史 第二轮：集成测试（并发修改阶段时每次实际变化各一行且最新一行与商机一致；只增不改；操作人无效或属于他组织时
 * 记为空且不影响写入；系统直接写库时修改人为空；删除商机级联删除；组织隔离；演示数据的推进路径；3000 行时报表性能）。
 * Deal stage history round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as stageHistory from '@/app/api/deals/[id]/stage-history/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as stageDuration from '@/app/api/reports/stage-duration/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
const newDeal = async (body: object = {}, t = a) => (await call(deals.POST, { token: t.token, body: { name: '商机', accountId: acc.id, amount: '1000', ...body } })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
});

describe('stage history R2 consistency', () => {
  it('并发修改阶段：行数等于实际变化次数，最新一行与商机当前阶段一致 / concurrent stage changes', async () => {
    const deal = await newDeal();
    const stages = ['NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'PROPOSAL', 'NEEDS_ANALYSIS', 'NEGOTIATION', 'PROPOSAL', 'QUALIFICATION', 'NEGOTIATION', 'PROPOSAL'];
    const res = await Promise.all(stages.map((stage) => call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { stage }, method: 'PATCH' })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const current = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
    const rows = await prisma.dealStageHistory.findMany({ where: { dealId: deal.id }, orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
    // 相邻两行阶段一定不同（每行都是一次实际变化）/ consecutive rows always differ
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.stage).not.toBe(rows[i - 1]!.stage);
    expect(rows.at(-1)!.stage).toBe(current.stage);
    const api = (await call(stageHistory.GET, { token: a.token, params: { id: deal.id } })).json.items;
    expect(api[0]).toMatchObject({ stage: current.stage, current: true });
    expect(api).toHaveLength(rows.length);
  });

  it('只增不改；操作人无效或属于他组织时记为空；直接写库时为空；删除商机级联 / database guards', async () => {
    const deal = await newDeal();
    const row = await prisma.dealStageHistory.findFirstOrThrow({ where: { dealId: deal.id } });
    await expect(prisma.$executeRaw`UPDATE deal_stage_history SET amount = 1 WHERE id = ${row.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE deal_stage_history SET amount = -1 WHERE id = ${row.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO deal_stage_history (id, organization_id, deal_id, stage, amount, currency, changed_at) VALUES (gen_random_uuid(), ${a.org.id}::uuid, ${deal.id}::uuid, 'PROPOSAL', -5, 'CNY', now())`).rejects.toThrow(/deal_stage_history_check/);
    const b = await createTenant('B');
    // 他组织用户作为操作人 → 记为空 / another organization's user as actor → null
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('yonlink.actor_id', ${b.user.id}, true) AS v`;
      await tx.deal.update({ where: { id: deal.id }, data: { stage: 'PROPOSAL' } });
    });
    // 非 UUID → 记为空且写入成功 / a non-UUID → null, the write still succeeds
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('yonlink.actor_id', 'not-a-uuid', true) AS v`;
      await tx.deal.update({ where: { id: deal.id }, data: { stage: 'NEGOTIATION' } });
    });
    // 未设置（系统写入）→ 空；设置只在事务内有效 / unset (system) → null; the setting is transaction-local
    await prisma.deal.update({ where: { id: deal.id }, data: { stage: 'CLOSED_WON' } });
    const rows = await prisma.dealStageHistory.findMany({ where: { dealId: deal.id }, orderBy: { changedAt: 'asc' } });
    expect(rows.map((r) => [r.stage, r.changedById])).toEqual([
      ['QUALIFICATION', a.user.id],
      ['PROPOSAL', null],
      ['NEGOTIATION', null],
      ['CLOSED_WON', null],
    ]);
    const api = (await call(stageHistory.GET, { token: a.token, params: { id: deal.id } })).json.items;
    expect(api[0].changedBy).toBeNull();
    // 删除商机级联 / deleting the deal cascades
    await prisma.deal.delete({ where: { id: deal.id } });
    expect(await prisma.dealStageHistory.count({ where: { dealId: deal.id } })).toBe(0);
  });

  it('组织隔离：B 的报表不含 A 的商机 / tenant isolation', async () => {
    await newDeal({ stage: 'PROPOSAL' });
    const b = await createTenant('B');
    const r = (await call(stageDuration.GET, { token: b.token })).json;
    expect(r.stages.every((s: { current: { count: number } }) => s.current.count === 0)).toBe(true);
    const mine = (await call(stageDuration.GET, { token: a.token })).json;
    expect(mine.stages.find((s: { stage: string }) => s.stage === 'PROPOSAL').current.count).toBe(1);
  });
});

describe('stage history R2 demo and volume', () => {
  it('演示数据：每个商机都有历史，首行为资格确认、末行为当前阶段、时间递增；报表有内容 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const list = await prisma.deal.findMany({ where: { organizationId: org.id }, include: { stageHistory: { orderBy: { changedAt: 'asc' } } } });
    expect(list.length).toBeGreaterThan(10);
    for (const d of list) {
      const h = d.stageHistory;
      expect(h.length, d.name).toBeGreaterThan(0);
      expect(h[0]!.stage).toBe('QUALIFICATION');
      expect(h.at(-1)!.stage).toBe(d.stage);
      for (let i = 1; i < h.length; i++) expect(h[i]!.changedAt.getTime()).toBeGreaterThan(h[i - 1]!.changedAt.getTime());
      expect(h.every((x) => x.changedById === d.ownerId)).toBe(true);
    }
    // 演示组织的报表：各进行中阶段都有已结束的停留，成交周期有赢单 / demo report: completed stays and won cycles exist
    const { stageDurationReport } = await import('@/server/modules/deal-stage-history');
    const admin = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'ADMIN' } });
    const r = await stageDurationReport({ organizationId: org.id, userId: admin.id, role: 'ADMIN' } as never, {});
    expect(r.stages.filter((x) => x.completed.count > 0).length).toBeGreaterThanOrEqual(3);
    expect(r.cycle.won.count).toBeGreaterThan(0);
  });

  it('3000 行历史：报表 3 秒内返回 / report on 3000 rows within 3 s', async () => {
    const deal = await newDeal();
    const many = await Promise.all(Array.from({ length: 999 }, () => prisma.deal.create({ data: { organizationId: a.org.id, accountId: acc.id, name: '批量', amount: 1 } })));
    const ids = [deal.id, ...many.map((d) => d.id)];
    await prisma.dealStageHistory.deleteMany({ where: { organizationId: a.org.id } });
    const now = Date.now();
    await prisma.dealStageHistory.createMany({
      data: ids.flatMap((id, i) =>
        (['QUALIFICATION', 'PROPOSAL', i % 2 ? 'CLOSED_WON' : 'NEGOTIATION'] as const).map((stage, j) => ({ organizationId: a.org.id, dealId: id, stage, amount: 1, currency: 'CNY', changedAt: new Date(now - (30 - j * 10) * 86_400_000) })),
      ),
    });
    const t0 = Date.now();
    const r = await call(stageDuration.GET, { token: a.token });
    expect(Date.now() - t0).toBeLessThan(3000);
    const s = Object.fromEntries(r.json.stages.map((x: { stage: string }) => [x.stage, x]));
    expect(s.QUALIFICATION.completed).toEqual({ count: 1000, avgDays: 10 });
    expect(s.PROPOSAL.completed).toEqual({ count: 1000, avgDays: 10 });
    expect(r.json.cycle.won).toEqual({ count: 500, avgDays: 20 });
  });
});
