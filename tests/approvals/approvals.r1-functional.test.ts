/**
 * 报价单审批 第一轮：功能测试（审批规则：默认不启用、保存与校验、权限、审计；需要审批的判断：折扣、金额折合人民币、缺少汇率；
 * 流程：未提交不能发送、提交（通知审批人、锁定修改/同步/删除/发送）、撤回、驳回需意见、驳回后修改再提交、批准后可发送、
 * 批准后修改需重新审批；不能审批自己的；销售不能审批；不需要审批时不能提交；审批历史与列表；不启用时不影响原流程）。
 * Quote approvals round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as approvalsRoute from '@/app/api/approvals/route';
import * as settingsRoute from '@/app/api/approvals/settings/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as rates from '@/app/api/exchange-rates/route';
import * as products from '@/app/api/products/route';
import * as history from '@/app/api/quotes/[id]/approval/route';
import * as decide from '@/app/api/quotes/[id]/approval/decide/route';
import * as recall from '@/app/api/quotes/[id]/approval/recall/route';
import * as submit from '@/app/api/quotes/[id]/approval/submit/route';
import * as quoteItem from '@/app/api/quotes/[id]/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quoteSync from '@/app/api/quotes/[id]/sync/route';
import * as quotes from '@/app/api/quotes/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let product: { id: string };
let acc: { id: string };

const settings = (body: object, token = a.token) => call(settingsRoute.PUT, { token, body: { enabled: true, maxDiscountPercent: '10', minTotal: '100000', ...body }, method: 'PUT' });
/** 销售新建商机（明细：数量、折扣）并生成报价单 / a rep creates a deal with a line and a quote */
async function repQuote(quantity: string, discountPercent: string, currency = 'CNY', token = rep.token) {
  const deal = (await call(deals.POST, { token, body: { name: '审批商机', accountId: acc.id, currency } })).json;
  // 明细产品须与商机同币种 / the line's product must share the deal currency
  const productId = currency === 'CNY' ? product.id : (await call(products.POST, { token: a.token, body: { sku: `P-${currency}-${Math.random()}`, name: '外币产品', unitPrice: '1000', currency } })).json.id;
  const item = await call(dealItems.POST, { token, params: { id: deal.id }, body: { productId, quantity, discountPercent } });
  expect(item.status).toBe(201);
  return (await call(quotes.POST, { token, body: { dealId: deal.id } })).json as { id: string; total: string; dealId: string };
}
const send = (id: string, token = rep.token) => call(quoteStatus.POST, { token, params: { id }, body: { status: 'SENT' } });
const doSubmit = (id: string, token = rep.token, comment: string | null = '请审批') => call(submit.POST, { token, params: { id }, body: { comment } });
const doDecide = (id: string, decision: 'APPROVE' | 'REJECT', comment: string | null, token = mgr.token) => call(decide.POST, { token, params: { id }, body: { decision, comment } });
const status = async (id: string) => (await prisma.quote.findUniqueOrThrow({ where: { id } })).approvalStatus;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  // 客户归销售，销售才能在其下建商机 / the account belongs to the rep so the rep can create deals under it
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', ownerId: rep.user.id } })).json;
  product = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '增压器', unitPrice: '1000' } })).json;
});

describe('approvals R1 policy', () => {
  it('默认不启用；保存、校验、权限、审计 / policy', async () => {
    expect((await call(settingsRoute.GET, { token: rep.token })).json).toMatchObject({ enabled: false, maxDiscountPercent: null, minTotal: null, baseCurrency: 'CNY' });
    const r = await settings({});
    expect(r.json).toMatchObject({ enabled: true, maxDiscountPercent: '10', minTotal: '100000', updatedBy: { id: a.user.id } });
    for (const body of [{ maxDiscountPercent: '101' }, { maxDiscountPercent: '-1' }, { maxDiscountPercent: '1.234' }, { minTotal: '-5' }, { minTotal: 'abc' }, { maxDiscountPercent: null, minTotal: null }, { extra: 1 }]) {
      expect((await settings(body)).status, JSON.stringify(body)).toBe(400);
    }
    // 不启用时可以两个条件都为空 / both criteria may be empty when disabled
    expect((await settings({ enabled: false, maxDiscountPercent: null, minTotal: null })).status).toBe(200);
    expect((await settings({}, rep.token)).status).toBe(403);
    expect((await settings({ minTotal: '50000' }, mgr.token)).status).toBe(200);
    const logs = await prisma.auditLog.findMany({ where: { action: 'approval.settings' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.changes)).toEqual([
      { fields: { enabled: [false, true], maxDiscountPercent: [null, '10'], minTotal: [null, '100000'] } },
      { fields: { enabled: [true, false], maxDiscountPercent: ['10', null], minTotal: ['100000', null] } },
      { fields: { enabled: [false, true], maxDiscountPercent: [null, '10'], minTotal: [null, '50000'] } },
    ]);
  });
});

describe('approvals R1 flow', () => {
  it('不启用时原流程不变；不需要审批时不能提交 / disabled policy and not-required quotes', async () => {
    const q = await repQuote('200', '30');
    expect((await doSubmit(q.id)).json.error.details).toEqual({ approvalStatus: ['not_required'] });
    expect((await send(q.id)).status).toBe(200);
    await settings({});
    const small = await repQuote('1', '5');
    expect((await doSubmit(small.id)).json.error.details).toEqual({ approvalStatus: ['not_required'] });
    expect((await send(small.id)).status).toBe(200);
  });

  it('完整流程：发送被拦、提交锁定、驳回需意见、修改再提交、批准、发送 / the whole flow', async () => {
    await settings({});
    const q = await repQuote('2', '15'); // 折扣 15% > 10%
    const blocked = await send(q.id);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details).toEqual({ approvalStatus: ['required', 'discount:15>10'] });

    const s = await doSubmit(q.id);
    expect(s.json).toEqual({ approvalStatus: 'PENDING', reasons: ['discount:15>10'], notified: 2 });
    // 通知管理员与经理（不含提交人）/ admins and managers are notified, not the submitter
    const notes = await prisma.notification.findMany({ where: { type: 'APPROVAL_REQUEST' }, select: { userId: true, dealId: true, actorId: true } });
    expect(notes.map((n) => n.userId).sort()).toEqual([a.user.id, mgr.user.id].sort());
    expect(notes.every((n) => n.dealId === q.dealId && n.actorId === rep.user.id)).toBe(true);
    // 待审批：锁定 / pending: locked
    expect((await doSubmit(q.id)).json.error.details).toEqual({ approvalStatus: ['pending'] });
    expect((await call(quoteItem.PATCH, { token: rep.token, params: { id: q.id }, body: { subject: '改' }, method: 'PATCH' })).json.error.details).toEqual({ approvalStatus: ['pending'] });
    expect((await call(quoteSync.POST, { token: rep.token, params: { id: q.id } })).json.error.details).toEqual({ approvalStatus: ['pending'] });
    expect((await call(quoteItem.DELETE, { token: rep.token, params: { id: q.id }, method: 'DELETE' })).json.error.details).toEqual({ approvalStatus: ['pending'] });
    expect((await send(q.id)).json.error.details).toEqual({ approvalStatus: ['pending'] });

    // 销售不能审批；驳回需意见 / reps cannot decide; rejections need a comment
    expect((await doDecide(q.id, 'APPROVE', null, rep.token)).status).toBe(403);
    expect((await doDecide(q.id, 'REJECT', null)).status).toBe(400);
    expect((await doDecide(q.id, 'REJECT', '折扣太大')).json).toEqual({ approvalStatus: 'REJECTED' });
    expect(await prisma.notification.count({ where: { type: 'APPROVAL_DECIDED', userId: rep.user.id } })).toBe(1);
    expect((await send(q.id)).json.error.details).toEqual({ approvalStatus: ['required', 'discount:15>10'] });
    expect((await doDecide(q.id, 'APPROVE', null)).json.error.details).toEqual({ approvalStatus: ['not_pending'] });

    // 驳回后可修改（清空结果），再提交、批准、发送 / editable after rejection (clears), resubmit, approve, send
    expect((await call(quoteItem.PATCH, { token: rep.token, params: { id: q.id }, body: { subject: '修改后' }, method: 'PATCH' })).status).toBe(200);
    expect(await status(q.id)).toBeNull();
    expect((await doSubmit(q.id, rep.token, null)).status).toBe(200);
    expect((await doDecide(q.id, 'APPROVE', null)).json).toEqual({ approvalStatus: 'APPROVED' });
    expect((await doSubmit(q.id)).json.error.details).toEqual({ approvalStatus: ['approved'] });
    expect((await send(q.id)).status).toBe(200);
    // 发送后仍显示已批准 / stays approved after sending
    expect(await status(q.id)).toBe('APPROVED');

    // 历史（最新在前）与审计 / history (newest first) and audit
    const h = (await call(history.GET, { token: rep.token, params: { id: q.id } })).json.items;
    expect(h.map((x: { action: string; actor: { id: string }; comment: string | null }) => [x.action, x.actor.id, x.comment])).toEqual([
      ['APPROVE', mgr.user.id, null],
      ['SUBMIT', rep.user.id, null],
      ['REJECT', mgr.user.id, '折扣太大'],
      ['SUBMIT', rep.user.id, '请审批'],
    ]);
    expect(h[3].reasons).toEqual(['discount:15>10']);
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'quote', entityId: q.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(actions).toEqual(['quote.create', 'quote.approval_submit', 'quote.reject', 'quote.update', 'quote.approval_submit', 'quote.approve', 'quote.status']);
    const upd = await prisma.auditLog.findFirstOrThrow({ where: { action: 'quote.update', entityId: q.id } });
    expect(upd.changes).toMatchObject({ approvalCleared: 'REJECTED' });
  });

  it('批准后修改需重新审批；撤回；不能审批自己提交的 / re-approval, recall, self-approval', async () => {
    await settings({});
    const q = await repQuote('200', '0'); // 200,000 ≥ 100,000
    await doSubmit(q.id);
    await doDecide(q.id, 'APPROVE', '同意');
    // 同步明细（内容可能变化）清空批准 / syncing clears the approval
    expect((await call(quoteSync.POST, { token: rep.token, params: { id: q.id } })).status).toBe(200);
    expect(await status(q.id)).toBeNull();
    expect((await send(q.id)).json.error.details).toEqual({ approvalStatus: ['required', 'total:200000.00>=100000'] });
    // 撤回：提交人可以；无关销售不能 / recall: the submitter may, other reps may not
    await doSubmit(q.id);
    const other = await addUser(a.org.id, 'SALES', '别的销售');
    expect((await call(recall.POST, { token: other.token, params: { id: q.id } })).status).toBe(404);
    expect((await call(recall.POST, { token: rep.token, params: { id: q.id } })).json).toEqual({ approvalStatus: null });
    expect((await call(recall.POST, { token: rep.token, params: { id: q.id } })).json.error.details).toEqual({ approvalStatus: ['not_pending'] });
    // 经理自己的报价单：自己不能批，管理员可以 / a manager's own quote: not by themself, the admin may
    const mq = await repQuote('300', '0', 'CNY', mgr.token);
    await doSubmit(mq.id, mgr.token);
    expect((await doDecide(mq.id, 'APPROVE', null, mgr.token)).json.error.details).toEqual({ approvalStatus: ['self_approval'] });
    expect((await doDecide(mq.id, 'APPROVE', null, a.token)).status).toBe(200);
  });

  it('外币按当天汇率折合人民币；没有汇率需审批 / foreign currency conversion', async () => {
    await settings({ maxDiscountPercent: null });
    const usd = await repQuote('20', '0', 'USD'); // 20,000 USD
    // 没有汇率 / no rate
    expect((await send(usd.id)).json.error.details).toEqual({ approvalStatus: ['required', 'total:no_rate'] });
    const today = new Date().toISOString().slice(0, 10);
    expect((await call(rates.PUT, { token: a.token, body: { currency: 'USD', rate: '4', effectiveDate: today }, method: 'PUT' })).status).toBe(200);
    expect((await send(usd.id)).status).toBe(200); // 80,000 < 100,000
    const usd2 = await repQuote('30', '0', 'USD'); // 120,000
    expect((await send(usd2.id)).json.error.details).toEqual({ approvalStatus: ['required', 'total:120000.00>=100000'] });
  });

  it('审批列表：待我审批（可否审批）、我提交的；销售不能看待审批 / lists', async () => {
    await settings({});
    const q1 = await repQuote('2', '20');
    const q2 = await repQuote('3', '20');
    await doSubmit(q1.id);
    await doSubmit(q2.id);
    await doDecide(q2.id, 'REJECT', '不行');
    const pending = (await call(approvalsRoute.GET, { token: mgr.token, query: { scope: 'pending' } })).json;
    expect(pending.items.map((x: { id: string; canDecide: boolean; submittedBy: { id: string } }) => [x.id, x.canDecide, x.submittedBy.id])).toEqual([[q1.id, true, rep.user.id]]);
    expect((await call(approvalsRoute.GET, { token: rep.token, query: { scope: 'pending' } })).status).toBe(403);
    const mine = (await call(approvalsRoute.GET, { token: rep.token, query: { scope: 'mine' } })).json;
    expect(mine.items.map((x: { id: string; approvalStatus: string }) => [x.id, x.approvalStatus]).sort()).toEqual([[q1.id, 'PENDING'], [q2.id, 'REJECTED']].sort());
    expect((await call(approvalsRoute.GET, { token: mgr.token, query: { scope: 'mine' } })).json.total).toBe(0);
    expect((await call(approvalsRoute.GET, { token: mgr.token, query: { scope: 'all' } })).status).toBe(400);
  });
});
