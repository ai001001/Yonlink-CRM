/**
 * 客户门户 第一轮：功能测试（设置与权限；邀请、接受、一次性令牌、过期；登录、限流、令牌隔离；停用、重设密码、门户关闭、
 * 联系人删除后会话失效；工单只看自己的、新建、公开评论、回复与重新打开、已关闭不能回复、通知与审计；报价单与发票范围；修改密码）。
 * Customer portal round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as contactPortal from '@/app/api/contacts/[id]/portal/route';
import * as portalDisable from '@/app/api/contacts/[id]/portal/disable/route';
import * as portalInvite from '@/app/api/contacts/[id]/portal/invite/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as accept from '@/app/api/portal/auth/accept/route';
import * as login from '@/app/api/portal/auth/login/route';
import * as logout from '@/app/api/portal/auth/logout/route';
import * as password from '@/app/api/portal/auth/password/route';
import * as invoices from '@/app/api/portal/invoices/route';
import * as me from '@/app/api/portal/me/route';
import * as quotes from '@/app/api/portal/quotes/route';
import * as ticketComments from '@/app/api/portal/tickets/[id]/comments/route';
import * as ticketItem from '@/app/api/portal/tickets/[id]/route';
import * as tickets from '@/app/api/portal/tickets/route';
import * as settings from '@/app/api/portal-settings/route';
import * as staffComments from '@/app/api/tickets/[id]/comments/route';
import * as staffTickets from '@/app/api/tickets/route';
import { prisma } from '@/server/db';
import { resetPortalLimiter } from '@/server/portal-auth';
import { addUser, call, createTenant, resetDb } from '../helpers';

const PW = 'Portal-pass-123';
let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;
let acc: { id: string };
let contact: { id: string; name: string };
let key: string;

const enable = async (token = a.token) => (await call(settings.PATCH, { token, body: { isEnabled: true, welcome: '欢迎' }, method: 'PATCH' })).json;
const invite = (id: string, token = a.token) => call(portalInvite.POST, { token, params: { id } });
const doAccept = (token: string, pw = PW) => call(accept.POST, { body: { token, password: pw } });
const doLogin = (email: string, pw = PW, k = key) => call(login.POST, { body: { portalKey: k, email, password: pw } });
const newContact = async (name: string, email: string | null, accountId = acc.id) => (await call(accountContacts.POST, { token: a.token, params: { id: accountId }, body: { name, ...(email ? { email } : {}) } })).json;
/** 开通并启用，返回门户令牌 / grant and activate, returning a portal token */
async function activate(c: { id: string }) {
  const inv = await invite(c.id);
  return (await doAccept(inv.json.token)).json.token as string;
}

beforeEach(async () => {
  await resetDb();
  resetPortalLimiter();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '远望', ownerId: sales.user.id } })).json;
  contact = await newContact('陈客户', 'Chen@Example.com');
  key = (await enable()).portalKey;
});

describe('portal R1 staff and auth', () => {
  it('设置：权限、生成标识、审计 / settings', async () => {
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
    expect((await call(settings.GET, { token: sales.token })).status).toBe(403);
    expect((await call(settings.GET, { token: mgr.token })).json).toMatchObject({ isEnabled: true, portalKey: key, welcome: '欢迎', counts: { invited: 0, active: 0, disabled: 0 } });
    expect((await call(settings.PATCH, { token: mgr.token, body: { welcome: ' ' }, method: 'PATCH' })).json.welcome).toBeNull();
    expect((await call(settings.PATCH, { token: a.token, body: { portalKey: 'x' }, method: 'PATCH' })).status).toBe(400);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'portal' } })).json.items;
    expect(logs.map((l: { action: string }) => l.action)).toEqual(['portal.settings', 'portal.settings']);
  });

  it('邀请、接受、一次性与过期、登录、限流、令牌隔离 / invitation, sign-in, limits, token separation', async () => {
    expect((await call(contactPortal.GET, { token: a.token, params: { id: contact.id } })).json).toEqual({ portal: null });
    const noEmail = await newContact('无邮箱', null);
    expect((await invite(noEmail.id)).json.error.details).toEqual({ email: ['required'] });
    expect((await invite(contact.id, sales.token)).status).toBe(403);
    const inv = await invite(contact.id);
    expect(inv.json).toMatchObject({ portalKey: key, portal: { status: 'INVITED', email: 'chen@example.com' } });
    expect(inv.json.token.length).toBeGreaterThan(30);
    // 审计不含令牌 / audits never hold the token
    const auditText = JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: a.org.id } }));
    expect(auditText).not.toContain(inv.json.token);
    expect(await prisma.portalUser.findFirstOrThrow()).toMatchObject({ passwordHash: null, inviteTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // 同邮箱的另一个联系人不能开通 / another contact with the same email cannot be granted
    const dup = await newContact('同邮箱', 'chen@example.com');
    expect((await invite(dup.id)).json.error.details).toEqual({ email: ['taken'] });
    // 接受：短密码、错误令牌、成功、一次性 / accept
    expect((await doAccept(inv.json.token, 'short')).status).toBe(400);
    expect((await doAccept('x'.repeat(43))).json.error.details).toEqual({ token: ['invalid'] });
    const ok = await doAccept(inv.json.token);
    expect(ok.json).toMatchObject({ token: expect.stringMatching(/^ylp_/), portalKey: key });
    expect((await doAccept(inv.json.token)).status).toBe(400);
    expect((await call(contactPortal.GET, { token: a.token, params: { id: contact.id } })).json.portal.status).toBe('ACTIVE');
    // 过期邀请 / expired invitation
    const c2 = await newContact('过期', 'late@example.com');
    const inv2 = await invite(c2.id);
    await prisma.portalUser.updateMany({ where: { contactId: c2.id }, data: { inviteExpiresAt: new Date(Date.now() - 1000) } });
    expect((await doAccept(inv2.json.token)).status).toBe(400);
    // 登录：大小写不敏感；错密码、未知邮箱、错误标识 401；限流 429 / sign-in
    expect((await doLogin('CHEN@example.com')).json.token).toMatch(/^ylp_/);
    expect((await doLogin('chen@example.com', 'wrong-password')).status).toBe(401);
    expect((await doLogin('nobody@example.com')).status).toBe(401);
    expect((await doLogin('chen@example.com', PW, 'x'.repeat(22))).status).toBe(401);
    for (let i = 0; i < 9; i++) await doLogin('chen@example.com', 'wrong-password');
    expect((await doLogin('chen@example.com')).status).toBe(429);
    resetPortalLimiter();
    // 令牌隔离：门户令牌不能访问员工接口，员工令牌与 API 密钥不能访问门户 / token separation
    const pt = ok.json.token;
    expect((await call(leads.GET, { token: pt })).status).toBe(401);
    expect((await call(me.GET, { token: a.token })).status).toBe(401);
    expect((await call(me.GET, { token: pt })).json).toEqual({ name: '陈客户', email: 'chen@example.com', account: '远望', organization: expect.any(String), welcome: '欢迎' });
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'portal' } })).json.items.map((l: { action: string }) => l.action);
    expect(logs).toEqual(expect.arrayContaining(['portal.invite', 'portal.activate', 'portal.login', 'portal.login_failed']));
  });

  it('停用、重设密码、门户关闭、联系人删除、退出、修改密码 / lifecycle', async () => {
    const t1 = await activate(contact);
    const t2 = (await doLogin('chen@example.com')).json.token;
    // 重设密码：仍可用旧密码，接受后旧会话失效 / reset: old password works until accepted, then old sessions end
    const reset = await invite(contact.id);
    expect(reset.json.portal.status).toBe('ACTIVE');
    expect((await call(me.GET, { token: t1 })).status).toBe(200);
    const t3 = (await doAccept(reset.json.token, 'Another-pass-456')).json.token;
    expect((await call(me.GET, { token: t1 })).status).toBe(401);
    expect((await doLogin('chen@example.com')).status).toBe(401);
    expect((await doLogin('chen@example.com', 'Another-pass-456')).status).toBe(200);
    // 修改密码：当前密码错 400；成功后其他会话失效、当前会话保留 / change password
    const t4 = (await doLogin('chen@example.com', 'Another-pass-456')).json.token;
    expect((await call(password.POST, { token: t3, body: { currentPassword: 'nope', newPassword: 'Third-pass-789' } })).json.error.details).toEqual({ currentPassword: ['wrong'] });
    expect((await call(password.POST, { token: t3, body: { currentPassword: 'Another-pass-456', newPassword: 'Third-pass-789' } })).status).toBe(204);
    expect((await call(me.GET, { token: t3 })).status).toBe(200);
    expect((await call(me.GET, { token: t4 })).status).toBe(401);
    void t2;
    // 门户关闭：会话立即失效；重新启用后恢复 / turning the portal off ends sessions at once
    await call(settings.PATCH, { token: a.token, body: { isEnabled: false }, method: 'PATCH' });
    expect((await call(me.GET, { token: t3 })).status).toBe(401);
    expect((await doLogin('chen@example.com', 'Third-pass-789')).status).toBe(401);
    expect((await invite(contact.id)).json.error.details).toEqual({ portal: ['disabled'] });
    await enable();
    expect((await call(me.GET, { token: t3 })).status).toBe(200);
    // 停用：会话结束、不能登录；再次邀请后恢复 / disabling
    const d = await call(portalDisable.POST, { token: mgr.token, params: { id: contact.id } });
    expect(d.json.portal.status).toBe('DISABLED');
    expect((await call(me.GET, { token: t3 })).status).toBe(401);
    expect(await prisma.portalSession.count()).toBe(0);
    expect((await doLogin('chen@example.com', 'Third-pass-789')).status).toBe(401);
    const again = await invite(contact.id);
    expect(again.json.portal.status).toBe('INVITED');
    const t5 = (await doAccept(again.json.token)).json.token;
    // 退出 / sign-out
    expect((await call(logout.POST, { token: t5 })).status).toBe(204);
    expect((await call(me.GET, { token: t5 })).status).toBe(401);
    // 联系人删除：门户用户随之删除 / deleting the contact removes the portal user
    const t6 = (await doLogin('chen@example.com')).json.token;
    expect((await call(contactItem.DELETE, { token: a.token, params: { id: contact.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(me.GET, { token: t6 })).status).toBe(401);
    expect(await prisma.portalUser.count()).toBe(0);
  });
});

describe('portal R1 customer side', () => {
  it('工单：只看自己的、新建、公开评论、回复与重新打开、已关闭、通知与审计 / tickets', async () => {
    const pt = await activate(contact);
    const other = await newContact('同客户的其他人', 'other@example.com');
    const otherAcc = (await call(accounts.POST, { token: a.token, body: { name: '别家' } })).json;
    const mine = (await call(staffTickets.POST, { token: a.token, body: { subject: '我的工单', accountId: acc.id, contactId: contact.id } })).json;
    const theirs = (await call(staffTickets.POST, { token: a.token, body: { subject: '同事的工单', accountId: acc.id, contactId: other.id } })).json;
    await call(staffTickets.POST, { token: a.token, body: { subject: '别家的工单', accountId: otherAcc.id } });
    expect((await call(tickets.GET, { token: pt })).json.items.map((x: { subject: string }) => x.subject)).toEqual(['我的工单']);
    expect((await call(ticketItem.GET, { token: pt, params: { id: theirs.id } })).status).toBe(404);
    // 新建：渠道门户、负责人为客户负责人、联系人为自己；通知与审计 / raise a ticket
    expect((await call(tickets.POST, { token: pt, body: { subject: ' ' } })).status).toBe(400);
    const created = await call(tickets.POST, { token: pt, body: { subject: '机器异响', description: '启动时有异响', type: 'PROBLEM' } });
    expect(created.status).toBe(201);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: created.json.id } });
    expect(row).toMatchObject({ channel: 'PORTAL', ownerId: sales.user.id, contactId: contact.id, accountId: acc.id, type: 'PROBLEM', status: 'OPEN' });
    expect(await prisma.notification.count({ where: { userId: sales.user.id, ticketId: row.id, type: 'ASSIGNED' } })).toBe(1);
    const log = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'ticket', action: 'ticket.create' } })).json.items[0];
    expect(log).toMatchObject({ actorId: null, changes: { via: 'portal', contact: '陈客户' } });
    expect((await call(staffTickets.GET, { token: sales.token })).json.items.map((x: { subject: string }) => x.subject)).toContain('机器异响');
    // 评论：内部备注不显示；员工回复显示姓名 / comments: internal notes hidden
    await call(staffComments.POST, { token: a.token, params: { id: mine.id }, body: { body: '内部：疑似批次问题', isInternal: true } });
    await call(staffComments.POST, { token: a.token, params: { id: mine.id }, body: { body: '您好，已安排工程师' } });
    const detail = (await call(ticketItem.GET, { token: pt, params: { id: mine.id } })).json;
    expect(detail.comments.map((c: { body: string; author: object }) => [c.body, c.author])).toEqual([['您好，已安排工程师', { kind: 'staff', name: a.user.name }]]);
    // 回复：等待客户/已解决时重新打开；通知负责人；员工看到客户回复 / replies reopen; owner notified
    await prisma.ticket.update({ where: { id: mine.id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: '已更换轴承', ownerId: sales.user.id } });
    const r = await call(ticketComments.POST, { token: pt, params: { id: mine.id }, body: { body: '问题还在' } });
    expect(r.json).toMatchObject({ body: '问题还在', reopened: true });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ status: 'OPEN', resolvedAt: null });
    expect(await prisma.notification.count({ where: { userId: sales.user.id, ticketId: mine.id, type: 'TICKET_COMMENT' } })).toBe(1);
    const staffView = (await call(staffComments.GET, { token: a.token, params: { id: mine.id } })).json.items as { body: string; author: unknown; portalUser: { contact: { name: string } } | null }[];
    expect(staffView.find((c) => c.body === '问题还在')).toMatchObject({ author: null, portalUser: { contact: { name: '陈客户' } } });
    expect((await call(ticketItem.GET, { token: pt, params: { id: mine.id } })).json.comments.at(-1).author).toEqual({ kind: 'customer', name: '陈客户', mine: true });
    expect((await call(ticketComments.POST, { token: pt, params: { id: mine.id }, body: { body: '补充' } })).json.reopened).toBe(false);
    await prisma.ticket.update({ where: { id: mine.id }, data: { status: 'CLOSED', resolvedAt: new Date(), resolution: '已更换轴承' } });
    expect((await call(ticketComments.POST, { token: pt, params: { id: mine.id }, body: { body: '再问' } })).json.error.details).toEqual({ ticket: ['closed'] });
    expect((await call(ticketComments.POST, { token: pt, params: { id: theirs.id }, body: { body: '越权' } })).status).toBe(404);
  });

  it('报价单与发票：只看所属客户的，不含草稿与作废；联系人换客户后随之变化 / quotes and invoices', async () => {
    const pt = await activate(contact);
    const otherAcc = (await call(accounts.POST, { token: a.token, body: { name: '别家' } })).json;
    const deal = async (accountId: string) => (await call(deals.POST, { token: a.token, body: { name: '商机', accountId } })).json;
    const d1 = await deal(acc.id);
    const d2 = await deal(otherAcc.id);
    const money = { currency: 'CNY', subtotal: '100.00', taxAmount: '0.00', total: '100.00' };
    let n = 0;
    const quote = (dealId: string, status: 'DRAFT' | 'SENT' | 'ACCEPTED') => prisma.quote.create({ data: { organizationId: a.org.id, dealId, quoteNumber: `Q-${++n}`, subject: `${status} 报价`, status, ...money } });
    const q1 = await quote(d1.id, 'SENT');
    await quote(d1.id, 'DRAFT');
    await quote(d1.id, 'ACCEPTED');
    await quote(d2.id, 'SENT');
    const order = await prisma.salesOrder.create({ data: { organizationId: a.org.id, quoteId: q1.id, dealId: d1.id, orderNumber: 'SO-1', subject: '订单', taxPercent: '0', ...money } });
    const invoice = (status: 'UNPAID' | 'PARTIALLY_PAID' | 'VOID', paid: string) =>
      prisma.invoice.create({ data: { organizationId: a.org.id, salesOrderId: order.id, dealId: d1.id, invoiceNumber: `INV-${++n}`, subject: `${status} 发票`, status, taxPercent: '0', ...money, paidAmount: paid, invoiceDate: new Date(), dueDate: new Date(), ...(status === 'VOID' ? { voidedAt: new Date() } : {}) } });
    await invoice('PARTIALLY_PAID', '30.00');
    await invoice('VOID', '0');
    expect((await call(quotes.GET, { token: pt })).json.items.map((q: { subject: string }) => q.subject).sort()).toEqual(['ACCEPTED 报价', 'SENT 报价']);
    expect((await call(invoices.GET, { token: pt })).json.items.map((i: { subject: string; balance: string }) => [i.subject, i.balance])).toEqual([['PARTIALLY_PAID 发票', '70.00']]);
    // 联系人换到别家：看到别家的报价单 / the contact moves to another account
    await prisma.contact.update({ where: { id: contact.id }, data: { accountId: otherAcc.id } });
    expect((await call(quotes.GET, { token: pt })).json.items.map((q: { quoteNumber: string }) => q.quoteNumber)).toEqual(['Q-4']);
    expect((await call(invoices.GET, { token: pt })).json.items).toEqual([]);
  });
});
