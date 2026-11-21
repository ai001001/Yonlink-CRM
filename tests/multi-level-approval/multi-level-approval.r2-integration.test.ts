/**
 * 多级审批 第二轮：集成测试（同一级两人并发批准只推进一次；数据库约束（只有待审批时有当前级别、级别设置范围）；
 * 组织隔离；删除商机后从回收站恢复保留级别快照与历史级别；演示数据的级别、快照与历史一致，经理可完成待审批单）。
 * Multi-level approval round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_APPROVAL, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as settingsRoute from '@/app/api/approvals/settings/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as products from '@/app/api/products/route';
import * as decide from '@/app/api/quotes/[id]/approval/decide/route';
import * as submit from '@/app/api/quotes/[id]/approval/submit/route';
import * as quotes from '@/app/api/quotes/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import { prisma } from '@/server/db';
import { approvalSteps, decideApproval } from '@/server/modules/approvals';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
const LEVELS = [
  { name: '经理审批', approverRole: 'MANAGER', minDiscountPercent: null, minTotal: null },
  { name: '管理员复核', approverRole: 'ADMIN', minDiscountPercent: null, minTotal: null },
];
async function submitted() {
  const acc = (await call(accounts.POST, { token: a.token, body: { name: `客户${Math.random()}`, ownerId: rep.user.id } })).json;
  const p = (await call(products.POST, { token: a.token, body: { sku: `P-${Math.random()}`, name: '产品', unitPrice: '1000' } })).json;
  const deal = (await call(deals.POST, { token: rep.token, body: { name: '商机', accountId: acc.id } })).json;
  await call(dealItems.POST, { token: rep.token, params: { id: deal.id }, body: { productId: p.id, quantity: '1', discountPercent: '30' } });
  const q = (await call(quotes.POST, { token: rep.token, body: { dealId: deal.id } })).json as { id: string; dealId: string };
  expect((await call(submit.POST, { token: rep.token, params: { id: q.id }, body: {} })).status).toBe(200);
  return q;
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  await call(settingsRoute.PUT, { token: a.token, body: { enabled: true, maxDiscountPercent: '10', minTotal: null, levels: LEVELS }, method: 'PUT' });
});

describe('multi-level approval R2', () => {
  it('同一级两人并发批准：只推进一次 / concurrent approvals advance once', async () => {
    const m1 = await addUser(a.org.id, 'MANAGER', '经理一');
    const m2 = await addUser(a.org.id, 'MANAGER', '经理二');
    const q = await submitted();
    const res = await Promise.all([m1, m2].map((m) => call(decide.POST, { token: m.token, params: { id: q.id }, body: { decision: 'APPROVE' } })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).approvalStep).toBe(1);
    expect(await prisma.quoteApproval.count({ where: { quoteId: q.id, action: 'APPROVE' } })).toBe(1);
  });

  it('数据库约束；组织隔离 / constraints and isolation', async () => {
    const q = await submitted();
    await expect(prisma.$executeRaw`UPDATE quotes SET approval_step = NULL WHERE id = ${q.id}::uuid`).rejects.toThrow(/quotes_approval_step_check/);
    await expect(prisma.$executeRaw`UPDATE quotes SET approval_status = 'APPROVED' WHERE id = ${q.id}::uuid`).rejects.toThrow(/quotes_approval_step_check/);
    await expect(prisma.$executeRaw`UPDATE quotes SET approval_steps = '{}'::jsonb WHERE id = ${q.id}::uuid`).rejects.toThrow(/quotes_approval_step_check/);
    await expect(prisma.quoteApprovalLevel.create({ data: { organizationId: a.org.id, position: 5, name: 'x', approverRole: 'ADMIN' } })).rejects.toThrow(/quote_approval_levels_check/);
    await expect(prisma.quoteApprovalLevel.create({ data: { organizationId: a.org.id, position: 4, name: 'x', approverRole: 'SALES' } })).rejects.toThrow(/quote_approval_levels_check/);
    await expect(prisma.quoteApprovalLevel.create({ data: { organizationId: a.org.id, position: 0, name: '重复', approverRole: 'ADMIN' } })).rejects.toThrow();
    const b = await createTenant('B');
    expect((await call(settingsRoute.GET, { token: b.token })).json.levels).toEqual([]);
    expect((await call(decide.POST, { token: b.token, params: { id: q.id }, body: { decision: 'APPROVE' } })).status).toBe(404);
  });

  it('回收站恢复保留级别快照与历史级别 / restore keeps snapshots and levels', async () => {
    const m = await addUser(a.org.id, 'MANAGER', '经理');
    const q = await submitted();
    await call(decide.POST, { token: m.token, params: { id: q.id }, body: { decision: 'APPROVE' } });
    const before = await prisma.quote.findUniqueOrThrow({ where: { id: q.id }, include: { approvals: { orderBy: { createdAt: 'asc' } } } });
    expect((await call(dealItem.DELETE, { token: a.token, params: { id: q.dealId }, method: 'DELETE' })).status).toBe(204);
    const item = (await call(bin.GET, { token: a.token, query: { entityType: 'deal' } })).json.items[0];
    expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    const after = await prisma.quote.findUniqueOrThrow({ where: { id: q.id }, include: { approvals: { orderBy: { createdAt: 'asc' } } } });
    expect([after.approvalStatus, after.approvalStep, after.approvalSteps, after.approvals.map((x) => [x.action, x.step])]).toEqual([
      before.approvalStatus,
      before.approvalStep,
      before.approvalSteps,
      before.approvals.map((x) => [x.action, x.step]),
    ]);
    // 恢复后可继续审批第二级 / approval continues at level 2 after the restore
    expect((await call(decide.POST, { token: a.token, params: { id: q.id }, body: { decision: 'APPROVE' } })).json.approvalStatus).toBe('APPROVED');
  });

  it('演示数据：级别、快照与历史一致；经理可完成待审批单 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const levels = await prisma.quoteApprovalLevel.findMany({ where: { organizationId: org.id }, orderBy: { position: 'asc' } });
    expect(levels.map((l) => [l.name, l.approverRole])).toEqual(DEMO_APPROVAL.levels.map((l) => [l.name, l.approverRole]));
    const list = await prisma.quote.findMany({ where: { organizationId: org.id, approvalStatus: { not: null } }, include: { lines: { select: { discountPercent: true } }, approvals: { orderBy: { createdAt: 'asc' } } }, orderBy: { quoteNumber: 'asc' } });
    for (const q of list) {
      expect(q.approvalSteps, q.quoteNumber).toEqual(await approvalSteps(prisma, org.id, q));
      const approved = q.approvals.filter((x) => x.action === 'APPROVE');
      if (q.approvalStatus === 'APPROVED') expect(approved.map((x) => x.step)).toEqual((q.approvalSteps as unknown[]).map((_, i) => i));
      // 同一次提交中每级由不同的人批准 / each level by a different person
      expect(new Set(approved.map((x) => x.actorId)).size).toBe(approved.length);
    }
    const pending = list.find((q) => q.approvalStatus === 'PENDING')!;
    expect(pending.approvalSteps).toEqual([{ name: '经理审批', role: 'MANAGER' }]);
    const manager = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'MANAGER' } });
    const r = await decideApproval({ organizationId: org.id, userId: manager.id, role: 'MANAGER' } as never, pending.id, { decision: 'APPROVE', comment: null });
    expect(r.approvalStatus).toBe('APPROVED');
  });
});
