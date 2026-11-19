/**
 * 报价单审批 第二轮：集成测试（两个审批人并发审批只有一个成功；并发提交只有一个成功；修改与提交并发时不会出现“待审批但内容已改”；
 * 组织隔离；数据库约束与历史只增不改；提交人停用后仍可审批（不通知）；通知中心与审计日志；演示数据可继续审批）。
 * Quote approvals round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as settingsRoute from '@/app/api/approvals/settings/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import * as deals from '@/app/api/deals/route';
import * as notifications from '@/app/api/notifications/route';
import * as products from '@/app/api/products/route';
import * as decide from '@/app/api/quotes/[id]/approval/decide/route';
import * as submit from '@/app/api/quotes/[id]/approval/submit/route';
import * as quoteItem from '@/app/api/quotes/[id]/route';
import * as quotes from '@/app/api/quotes/route';
import { prisma } from '@/server/db';
import { approvalReasons, decideApproval } from '@/server/modules/approvals';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let mgr: Awaited<ReturnType<typeof addUser>>;

async function quoteFor(t: { org: { id: string }; token: string }, ownerId: string, token = t.token) {
  const acc = (await call(accounts.POST, { token: t.token, body: { name: `客户${Math.random()}`, ownerId } })).json;
  const p = (await call(products.POST, { token: t.token, body: { sku: `P-${Math.random()}`, name: '产品', unitPrice: '1000' } })).json;
  const deal = (await call(deals.POST, { token, body: { name: '商机', accountId: acc.id } })).json;
  await call(dealItems.POST, { token, params: { id: deal.id }, body: { productId: p.id, quantity: '1', discountPercent: '30' } });
  return (await call(quotes.POST, { token, body: { dealId: deal.id } })).json as { id: string };
}
const enable = (token = a.token) => call(settingsRoute.PUT, { token, body: { enabled: true, maxDiscountPercent: '10', minTotal: null }, method: 'PUT' });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  await enable();
});

describe('approvals R2 concurrency', () => {
  it('两个审批人并发：只有一个成功，历史只有一条决定 / concurrent decisions', async () => {
    const q = await quoteFor(a, rep.user.id, rep.token);
    await call(submit.POST, { token: rep.token, params: { id: q.id }, body: {} });
    const res = await Promise.all([
      call(decide.POST, { token: mgr.token, params: { id: q.id }, body: { decision: 'APPROVE' } }),
      call(decide.POST, { token: a.token, params: { id: q.id }, body: { decision: 'REJECT', comment: '不同意' } }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.quoteApproval.count({ where: { quoteId: q.id, action: { in: ['APPROVE', 'REJECT'] } } })).toBe(1);
  });

  it('并发提交只有一个成功；修改与提交并发不会出现“待审批但内容已改” / concurrent submit and edit', async () => {
    const q = await quoteFor(a, rep.user.id, rep.token);
    const subs = await Promise.all(Array.from({ length: 5 }, () => call(submit.POST, { token: rep.token, params: { id: q.id }, body: {} })));
    expect(subs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.quoteApproval.count({ where: { quoteId: q.id, action: 'SUBMIT' } })).toBe(1);
    for (let round = 0; round < 5; round++) {
      const q2 = await quoteFor(a, rep.user.id, rep.token);
      await Promise.all([
        call(quoteItem.PATCH, { token: rep.token, params: { id: q2.id }, body: { subject: `改${round}` }, method: 'PATCH' }),
        call(submit.POST, { token: rep.token, params: { id: q2.id }, body: {} }),
      ]);
      const final = await prisma.quote.findUniqueOrThrow({ where: { id: q2.id } });
      if (final.approvalStatus === 'PENDING') {
        // 待审批时，提交之后不应再有修改 / once pending, no edit may follow the submission
        const logs = await prisma.auditLog.findMany({ where: { entityId: q2.id, action: { in: ['quote.update', 'quote.approval_submit'] } }, orderBy: { createdAt: 'asc' } });
        expect(logs.at(-1)!.action).toBe('quote.approval_submit');
      }
    }
  });
});

describe('approvals R2 isolation and data', () => {
  it('组织隔离：B 的经理不能审批 A 的报价单；规则互不影响 / tenant isolation', async () => {
    const q = await quoteFor(a, rep.user.id, rep.token);
    await call(submit.POST, { token: rep.token, params: { id: q.id }, body: {} });
    const b = await createTenant('B');
    expect((await call(decide.POST, { token: b.token, params: { id: q.id }, body: { decision: 'APPROVE' } })).status).toBe(404);
    expect((await call(settingsRoute.GET, { token: b.token })).json.enabled).toBe(false);
    const bq = await quoteFor(b, b.user.id);
    expect((await call(submit.POST, { token: b.token, params: { id: bq.id }, body: {} })).json.error.details).toEqual({ approvalStatus: ['not_required'] });
  });

  it('数据库约束与历史只增不改 / database guards', async () => {
    const q = await quoteFor(a, rep.user.id, rep.token);
    await expect(prisma.$executeRaw`UPDATE quotes SET status = 'SENT', approval_status = 'PENDING' WHERE id = ${q.id}::uuid`).rejects.toThrow(/quotes_approval_check/);
    await expect(prisma.$executeRaw`UPDATE quotes SET approval_reasons = '["x"]'::jsonb WHERE id = ${q.id}::uuid`).rejects.toThrow(/quotes_approval_check/);
    await expect(prisma.$executeRaw`UPDATE quote_approval_settings SET max_discount_percent = 120 WHERE organization_id = ${a.org.id}::uuid`).rejects.toThrow(/quote_approval_settings_check/);
    await call(submit.POST, { token: rep.token, params: { id: q.id }, body: { comment: '说明' } });
    const row = await prisma.quoteApproval.findFirstOrThrow({ where: { quoteId: q.id } });
    await expect(prisma.$executeRaw`UPDATE quote_approvals SET comment = 'x' WHERE id = ${row.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(prisma.quoteApproval.create({ data: { organizationId: a.org.id, quoteId: q.id, action: 'APPROVE', actorId: mgr.user.id, comment: '  ' } })).rejects.toThrow(/quote_approvals_check/);
    // 删除报价单不受历史阻碍（级联）/ history cascades with the quote
    await prisma.quote.delete({ where: { id: q.id } });
    expect(await prisma.quoteApproval.count({ where: { quoteId: q.id } })).toBe(0);
  });

  it('提交人停用后仍可审批（不通知）；通知中心与审计日志 / inactive submitter, notifications and audit', async () => {
    const q = await quoteFor(a, rep.user.id, rep.token);
    await call(submit.POST, { token: rep.token, params: { id: q.id }, body: {} });
    const inbox = (await call(notifications.GET, { token: mgr.token })).json.items;
    expect(inbox[0]).toMatchObject({ type: 'APPROVAL_REQUEST', actor: { id: rep.user.id }, dealId: expect.any(String) });
    await prisma.user.update({ where: { id: rep.user.id }, data: { isActive: false } });
    expect((await call(decide.POST, { token: mgr.token, params: { id: q.id }, body: { decision: 'APPROVE' } })).status).toBe(200);
    expect(await prisma.notification.count({ where: { type: 'APPROVAL_DECIDED' } })).toBe(0);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'quote' } })).json.items.map((l: { action: string }) => l.action);
    expect(logs.slice(0, 2)).toEqual(['quote.approve', 'quote.approval_submit']);
    await enable();
    expect((await call(auditLogs.GET, { token: a.token, query: { entityType: 'approval' } })).json.items[0]).toMatchObject({ action: 'approval.settings' });
  });
});

describe('approvals R2 recycle bin', () => {
  it('删除商机后从回收站恢复：报价单审批状态、原因与历史一并恢复 / restore keeps approvals', async () => {
    const q = await quoteFor(a, rep.user.id, rep.token);
    const untouched = await quoteFor(a, rep.user.id, rep.token);
    await call(submit.POST, { token: rep.token, params: { id: q.id }, body: { comment: '说明' } });
    await call(decide.POST, { token: mgr.token, params: { id: q.id }, body: { decision: 'APPROVE' } });
    for (const id of [q.id, untouched.id]) {
      const before = await prisma.quote.findUniqueOrThrow({ where: { id }, include: { approvals: { orderBy: { createdAt: 'asc' } } } });
      expect((await call(dealItem.DELETE, { token: a.token, params: { id: before.dealId }, method: 'DELETE' })).status).toBe(204);
      const item = (await call(bin.GET, { token: a.token, query: { entityType: 'deal' } })).json.items[0];
      expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
      const after = await prisma.quote.findUniqueOrThrow({ where: { id }, include: { approvals: { orderBy: { createdAt: 'asc' } } } });
      expect([after.approvalStatus, after.approvalReasons, after.approvals.map((x) => [x.id, x.action, x.comment, x.reasons])]).toEqual([
        before.approvalStatus,
        before.approvalReasons,
        before.approvals.map((x) => [x.id, x.action, x.comment, x.reasons]),
      ]);
    }
  });
});

describe('approvals R2 demo', () => {
  it('演示数据：规则、已批准与待审批的报价单、原因与计算一致；经理可审批待审批单并通知提交人 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const s = await prisma.quoteApprovalSettings.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect([s.enabled, s.maxDiscountPercent?.toString(), s.minTotal?.toString()]).toEqual([true, '5', '1000000']);
    const list = await prisma.quote.findMany({ where: { organizationId: org.id, approvalStatus: { not: null } }, include: { lines: { select: { discountPercent: true } }, approvals: { orderBy: { createdAt: 'asc' } } }, orderBy: { quoteNumber: 'asc' } });
    expect(list.map((q) => [q.status, q.approvalStatus, q.approvals.map((x) => x.action)])).toEqual([
      ['DRAFT', 'APPROVED', ['SUBMIT', 'APPROVE']],
      ['DRAFT', 'PENDING', ['SUBMIT']],
    ]);
    for (const q of list) expect(q.approvalReasons).toEqual(await approvalReasons(prisma, org.id, q));
    const pending = list[1]!;
    const manager = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'MANAGER' } });
    const submitter = pending.approvals[0]!.actorId;
    expect(submitter).not.toBe(manager.id);
    await decideApproval({ organizationId: org.id, userId: manager.id, role: 'MANAGER' } as never, pending.id, { decision: 'APPROVE', comment: null });
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: pending.id } })).approvalStatus).toBe('APPROVED');
    expect(await prisma.notification.count({ where: { userId: submitter, type: 'APPROVAL_DECIDED' } })).toBe(1);
  });
});
