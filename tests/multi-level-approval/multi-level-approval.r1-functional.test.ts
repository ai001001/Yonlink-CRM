/**
 * 多级审批 第一轮：功能测试（级别设置：保存、校验、最多 5 级、审计；适用级别：无条件、折扣超过、金额达到、无汇率、都不适用时一级；
 * 逐级审批：第一级经理批准后进入第二级并通知管理员、同一人不能批两级、经理不能批管理员级、最后一级批准完成、任一级驳回结束；
 * 提交后改级别不影响已提交的审批；列表的当前级别与能否审批；历史记录级别）。
 * Multi-level approval round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as approvalsRoute from '@/app/api/approvals/route';
import * as settingsRoute from '@/app/api/approvals/settings/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as products from '@/app/api/products/route';
import * as history from '@/app/api/quotes/[id]/approval/route';
import * as decide from '@/app/api/quotes/[id]/approval/decide/route';
import * as submit from '@/app/api/quotes/[id]/approval/submit/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let mgr2: Awaited<ReturnType<typeof addUser>>;
let admin2: Awaited<ReturnType<typeof addUser>>;
let acc: { id: string };
let product: { id: string };

const LEVELS = [
  { name: '经理审批', approverRole: 'MANAGER', minDiscountPercent: '10', minTotal: null },
  { name: '管理员复核', approverRole: 'ADMIN', minDiscountPercent: null, minTotal: '100000' },
];
const settings = (levels: object[] = LEVELS, token = a.token) => call(settingsRoute.PUT, { token, body: { enabled: true, maxDiscountPercent: '5', minTotal: '50000', levels }, method: 'PUT' });
async function repQuote(quantity: string, discountPercent: string) {
  const deal = (await call(deals.POST, { token: rep.token, body: { name: '审批商机', accountId: acc.id } })).json;
  await call(dealItems.POST, { token: rep.token, params: { id: deal.id }, body: { productId: product.id, quantity, discountPercent } });
  return (await call(quotes.POST, { token: rep.token, body: { dealId: deal.id } })).json as { id: string; dealId: string };
}
const doSubmit = (id: string) => call(submit.POST, { token: rep.token, params: { id }, body: {} });
const doDecide = (id: string, token: string, decision: 'APPROVE' | 'REJECT' = 'APPROVE', comment: string | null = null) => call(decide.POST, { token, params: { id }, body: { decision, comment } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  mgr2 = await addUser(a.org.id, 'MANAGER', '经理二');
  admin2 = await addUser(a.org.id, 'ADMIN', '管理员二');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', ownerId: rep.user.id } })).json;
  product = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '增压器', unitPrice: '1000' } })).json;
});

describe('multi-level approval R1 settings', () => {
  it('保存级别、校验、最多 5 级、审计 / levels', async () => {
    const r = await settings();
    expect(r.json.levels).toEqual(LEVELS);
    const bad: object[][] = [
      [{ name: ' ', approverRole: 'MANAGER' }],
      [{ name: 'x', approverRole: 'SALES' }],
      [{ name: 'x', approverRole: 'ADMIN', minDiscountPercent: '120' }],
      [{ name: 'x', approverRole: 'ADMIN', minTotal: '-1' }],
      Array.from({ length: 6 }, (_, i) => ({ name: `L${i}`, approverRole: 'ADMIN' })),
    ];
    for (const levels of bad) expect((await settings(levels)).status, JSON.stringify(levels)).toBe(400);
    expect((await settings([], mgr.token)).json.levels).toEqual([]);
    const logs = await prisma.auditLog.findMany({ where: { action: 'approval.settings' }, orderBy: { createdAt: 'asc' } });
    expect((logs[0]!.changes as { fields: { levels: string[][] } }).fields.levels).toEqual([[], ['经理审批:MANAGER discount>10', '管理员复核:ADMIN total>=100000']]);
    expect((logs[1]!.changes as { fields: { levels: string[][] } }).fields.levels[1]).toEqual([]);
  });
});

describe('multi-level approval R1 flow', () => {
  it('适用级别：折扣、金额、都适用、都不适用时一级 / applicable levels', async () => {
    await settings();
    const steps = async (q: { id: string }) => (await doSubmit(q.id)).json.steps.map((s: { name: string | null }) => s.name);
    expect(await steps(await repQuote('2', '20'))).toEqual(['经理审批']); // 折扣 20%、1,600 / discount only
    expect(await steps(await repQuote('200', '0'))).toEqual(['管理员复核']); // 200,000 / amount only
    expect(await steps(await repQuote('200', '20'))).toEqual(['经理审批', '管理员复核']); // 两者 / both
    expect(await steps(await repQuote('60', '8'))).toEqual([null]); // 需要审批但没有级别适用 → 一级 / needs approval, no level applies
  });

  it('逐级审批：通知、同一人不能批两级、角色限制、最后一级完成、可发送 / level by level', async () => {
    await settings();
    const q = await repQuote('200', '20');
    expect((await doSubmit(q.id)).json.notified).toBe(4); // 第一级：经理级 → 两名经理 + 两名管理员 / managers and admins
    // 第一级：经理批准 → 进入第二级并通知管理员（不含提交人与已批准的人）/ level 1 → level 2, admins notified
    const before = await prisma.notification.count({ where: { type: 'APPROVAL_REQUEST' } });
    const r1 = await doDecide(q.id, mgr.token);
    expect(r1.json).toMatchObject({ approvalStatus: 'PENDING', step: 1 });
    const added = await prisma.notification.findMany({ where: { type: 'APPROVAL_REQUEST' }, orderBy: { createdAt: 'desc' }, take: (await prisma.notification.count({ where: { type: 'APPROVAL_REQUEST' } })) - before });
    expect(added.map((n) => n.userId).sort()).toEqual([a.user.id, admin2.user.id].sort());
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).approvalStep).toBe(1);
    // 第二级：经理不能批；第一级的批准人不能再批；仍不能发送 / managers cannot; the level-1 approver cannot; not sendable
    expect((await doDecide(q.id, mgr2.token)).json.error.details).toEqual({ approvalStatus: ['not_your_level'] });
    expect((await call(quoteStatus.POST, { token: rep.token, params: { id: q.id }, body: { status: 'SENT' } })).json.error.details).toEqual({ approvalStatus: ['pending'] });
    expect((await doDecide(q.id, admin2.token)).json).toMatchObject({ approvalStatus: 'APPROVED', step: null });
    expect(await prisma.notification.count({ where: { type: 'APPROVAL_DECIDED', userId: rep.user.id } })).toBe(1);
    expect((await call(quoteStatus.POST, { token: rep.token, params: { id: q.id }, body: { status: 'SENT' } })).status).toBe(200);
    // 历史记录级别 / history records levels
    const h = (await call(history.GET, { token: rep.token, params: { id: q.id } })).json.items;
    expect(h.map((x: { action: string; step: number | null; actor: { id: string } }) => [x.action, x.step, x.actor.id])).toEqual([
      ['APPROVE', 1, admin2.user.id],
      ['APPROVE', 0, mgr.user.id],
      ['SUBMIT', null, rep.user.id],
    ]);
    const audits = await prisma.auditLog.findMany({ where: { action: 'quote.approve', entityId: q.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((l) => l.changes)).toEqual([
      { step: 1, of: 2, level: '经理审批', comment: null },
      { step: 2, of: 2, level: '管理员复核', comment: null },
    ]);
  });

  it('同一管理员不能批两级；任一级驳回结束；提交后改级别不影响 / one person per submission, rejection, snapshots', async () => {
    await settings();
    const q = await repQuote('200', '20');
    await doSubmit(q.id);
    expect((await doDecide(q.id, a.token)).json.step).toBe(1); // 管理员批了经理级 / an admin approved the manager level
    expect((await doDecide(q.id, a.token)).json.error.details).toEqual({ approvalStatus: ['already_approved_level'] });
    // 改级别：已提交的仍按快照 / changing levels keeps the snapshot
    await settings([{ name: '只要经理', approverRole: 'MANAGER', minDiscountPercent: null, minTotal: null }]);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).approvalSteps).toEqual([{ name: '经理审批', role: 'MANAGER' }, { name: '管理员复核', role: 'ADMIN' }]);
    expect((await doDecide(q.id, mgr.token)).status).toBe(403);
    expect((await doDecide(q.id, admin2.token, 'REJECT', '金额过大')).json).toMatchObject({ approvalStatus: 'REJECTED', step: null });
    // 重新提交：按新级别从第一级开始，之前的批准不算 / resubmission uses the new levels from level 1
    const again = await doSubmit(q.id);
    expect(again.json.steps).toEqual([{ name: '只要经理', role: 'MANAGER' }]);
    expect((await doDecide(q.id, a.token)).json.approvalStatus).toBe('APPROVED');
  });

  it('列表：当前级别与能否审批 / the pending list', async () => {
    await settings();
    const q = await repQuote('200', '20');
    await doSubmit(q.id);
    const rowFor = async (token: string) => (await call(approvalsRoute.GET, { token, query: { scope: 'pending' } })).json.items.find((x: { id: string }) => x.id === q.id);
    expect(await rowFor(mgr.token)).toMatchObject({ approvalStep: 0, canDecide: true });
    await doDecide(q.id, mgr.token);
    expect(await rowFor(mgr.token)).toMatchObject({ approvalStep: 1, canDecide: false });
    expect(await rowFor(mgr2.token)).toMatchObject({ canDecide: false });
    expect(await rowFor(admin2.token)).toMatchObject({ canDecide: true, approvalSteps: [{ name: '经理审批', role: 'MANAGER' }, { name: '管理员复核', role: 'ADMIN' }] });
  });
});
