/**
 * 客户门户 第二轮：集成测试（同一邀请并发接受只成功一次；同邮箱并发开通只成功一个；会话过期；数据库约束；
 * 门户用户删除后评论保留；员工对客户回复的编辑与删除；组织隔离（同一邮箱在两个组织各自登录）；工单列表上限；演示门户）。
 * Customer portal round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_PORTAL } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as staffComment from '@/app/api/ticket-comments/[id]/route';
import * as portalInvite from '@/app/api/contacts/[id]/portal/invite/route';
import * as accept from '@/app/api/portal/auth/accept/route';
import * as login from '@/app/api/portal/auth/login/route';
import * as me from '@/app/api/portal/me/route';
import * as quotes from '@/app/api/portal/quotes/route';
import * as ticketComments from '@/app/api/portal/tickets/[id]/comments/route';
import * as tickets from '@/app/api/portal/tickets/route';
import * as settings from '@/app/api/portal-settings/route';
import { hashToken } from '@/server/auth';
import { prisma } from '@/server/db';
import { resetPortalLimiter } from '@/server/portal-auth';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { randomBytes } from 'node:crypto';

const PW = 'Portal-pass-123';
let a: Awaited<ReturnType<typeof createTenant>>;

/** 建立启用门户的组织与一个联系人 / an organization with the portal enabled and one contact */
async function setup(t: Awaited<ReturnType<typeof createTenant>>, email = 'chen@example.com') {
  const key = (await call(settings.PATCH, { token: t.token, body: { isEnabled: true }, method: 'PATCH' })).json.portalKey as string;
  const acc = (await call(accounts.POST, { token: t.token, body: { name: '客户' } })).json;
  const contact = (await call(accountContacts.POST, { token: t.token, params: { id: acc.id }, body: { name: '陈客户', email } })).json;
  return { key, acc, contact };
}

beforeEach(async () => {
  await resetDb();
  resetPortalLimiter();
  a = await createTenant('A');
});

describe('portal R2', () => {
  it('并发：同一邀请只接受一次；同邮箱并发开通只成功一个；会话过期 / concurrency and expiry', async () => {
    const { acc, contact, key } = await setup(a);
    const inv = (await call(portalInvite.POST, { token: a.token, params: { id: contact.id } })).json;
    const res = await Promise.all([1, 2, 3].map((i) => call(accept.POST, { body: { token: inv.token, password: `${PW}-${i}` } })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(await prisma.portalSession.count()).toBe(1);
    const winner = res.findIndex((r) => r.status === 200) + 1;
    expect((await call(login.POST, { body: { portalKey: key, email: 'chen@example.com', password: `${PW}-${winner}` } })).status).toBe(200);
    // 同邮箱的两个联系人同时开通 / two contacts with one email granted at once
    const c1 = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '甲', email: 'same@example.com' } })).json;
    const c2 = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '乙', email: 'same@example.com' } })).json;
    const both = await Promise.all([c1, c2].map((c) => call(portalInvite.POST, { token: a.token, params: { id: c.id } })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    // 会话过期 / expired sessions
    const tok = res.find((r) => r.status === 200)!.json.token;
    await prisma.portalSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(me.GET, { token: tok })).status).toBe(401);
  });

  it('数据库约束；门户用户删除后评论保留；员工对客户回复的编辑与删除 / constraints and comments', async () => {
    const { contact, acc } = await setup(a);
    const inv = (await call(portalInvite.POST, { token: a.token, params: { id: contact.id } })).json;
    const tok = (await call(accept.POST, { body: { token: inv.token, password: PW } })).json.token;
    const u = await prisma.portalUser.findFirstOrThrow();
    await expect(prisma.$executeRaw`UPDATE portal_users SET email = 'Chen@Example.com' WHERE id = ${u.id}::uuid`).rejects.toThrow(/portal_users_check/);
    await expect(prisma.$executeRaw`UPDATE portal_users SET password_hash = NULL WHERE id = ${u.id}::uuid`).rejects.toThrow(/portal_users_check/);
    await expect(prisma.$executeRaw`UPDATE portal_users SET status = 'INVITED' WHERE id = ${u.id}::uuid`).rejects.toThrow(/portal_users_check/);
    await expect(prisma.$executeRaw`UPDATE portal_users SET invite_token_hash = ${'a'.repeat(64)} WHERE id = ${u.id}::uuid`).rejects.toThrow(/portal_users_check/);
    await expect(prisma.$executeRaw`UPDATE portal_settings SET portal_key = 'bad key!' WHERE organization_id = ${a.org.id}::uuid`).rejects.toThrow(/portal_settings_check/);
    const b = await createTenant('B');
    const bAcc = (await call(accounts.POST, { token: b.token, body: { name: 'B 客户' } })).json;
    const bContact = (await call(accountContacts.POST, { token: b.token, params: { id: bAcc.id }, body: { name: 'B 联系人', email: 'b@example.com' } })).json;
    await expect(prisma.portalUser.create({ data: { organizationId: a.org.id, contactId: bContact.id, email: 'x@example.com', invitedById: a.user.id, inviteTokenHash: 'b'.repeat(64), inviteExpiresAt: new Date() } })).rejects.toThrow();
    // 客户回复：员工不能编辑，经理可删除；同时有两个作者被拒绝 / staff cannot edit customer replies; managers may delete
    const ticket = await prisma.ticket.create({ data: { organizationId: a.org.id, ticketNumber: 'T-1', subject: '问题', accountId: acc.id, contactId: contact.id } });
    const c = (await call(ticketComments.POST, { token: tok, params: { id: ticket.id }, body: { body: '客户回复' } })).json;
    await expect(prisma.$executeRaw`UPDATE ticket_comments SET author_id = ${a.user.id}::uuid WHERE id = ${c.id}::uuid`).rejects.toThrow(/ticket_comments_author_check/);
    expect((await call(staffComment.PATCH, { token: a.token, params: { id: c.id }, body: { body: '篡改' }, method: 'PATCH' })).status).toBe(403);
    const c2 = (await call(ticketComments.POST, { token: tok, params: { id: ticket.id }, body: { body: '第二条' } })).json;
    const mgr = await addUser(a.org.id, 'MANAGER', '经理');
    expect((await call(staffComment.DELETE, { token: mgr.token, params: { id: c2.id }, method: 'DELETE' })).status).toBe(204);
    // 删除门户用户：评论保留，作者置空，组织不变 / deleting the portal user keeps the comment
    await prisma.portalUser.delete({ where: { id: u.id } });
    expect(await prisma.ticketComment.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ portalUserId: null, authorId: null, organizationId: a.org.id, body: '客户回复' });
  });

  it('组织隔离：同一邮箱在两个组织各自登录，只看到本组织数据；工单列表最多 200 条 / isolation and limits', async () => {
    const A = await setup(a);
    const b = await createTenant('B');
    const B = await setup(b);
    const activate = async (t: typeof a, c: { id: string }) => (await call(accept.POST, { body: { token: (await call(portalInvite.POST, { token: t.token, params: { id: c.id } })).json.token, password: PW } })).json.token as string;
    const ta = await activate(a, A.contact);
    const tb = await activate(b, B.contact);
    await call(tickets.POST, { token: ta, body: { subject: 'A 的工单' } });
    await call(tickets.POST, { token: tb, body: { subject: 'B 的工单' } });
    expect((await call(tickets.GET, { token: ta })).json.items.map((x: { subject: string }) => x.subject)).toEqual(['A 的工单']);
    expect((await call(tickets.GET, { token: tb })).json.items.map((x: { subject: string }) => x.subject)).toEqual(['B 的工单']);
    // 用 A 的标识登录只能进入 A / signing in with A's key reaches A only
    const la = (await call(login.POST, { body: { portalKey: A.key, email: 'chen@example.com', password: PW } })).json.token;
    expect((await call(me.GET, { token: la })).json.account).toBe('客户');
    expect((await call(tickets.GET, { token: la })).json.items).toHaveLength(1);
    // B 的门户关闭不影响 A / turning B off does not affect A
    await call(settings.PATCH, { token: b.token, body: { isEnabled: false }, method: 'PATCH' });
    expect((await call(me.GET, { token: tb })).status).toBe(401);
    expect((await call(me.GET, { token: ta })).status).toBe(200);
    // 列表上限 / list limit
    await prisma.ticket.createMany({ data: Array.from({ length: 230 }, (_, i) => ({ organizationId: a.org.id, ticketNumber: `X-${i}`, subject: `批量${i}`, accountId: A.acc.id, contactId: A.contact.id })) });
    expect((await call(tickets.GET, { token: ta })).json.items).toHaveLength(200);
  });

  it('演示门户：已启用、固定标识；开通演示联系人后看到其工单与所属客户的报价单 / demo portal', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const s = await prisma.portalSettings.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(s).toMatchObject({ isEnabled: true, portalKey: DEMO_PORTAL.key(org.id), welcome: DEMO_PORTAL.welcome });
    expect(await prisma.portalUser.count({ where: { organizationId: org.id } })).toBe(0);
    // 以演示管理员开通一个有工单的演示联系人 / grant a demo contact that has tickets
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.yonlink.test' } });
    const token = randomBytes(32).toString('base64url');
    await prisma.session.create({ data: { userId: admin.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { organizationId: org.id, contactId: { not: null } }, include: { contact: true } });
    const inv = (await call(portalInvite.POST, { token, params: { id: ticket.contactId! } })).json;
    expect(inv.portalKey).toBe(s.portalKey);
    const pt = (await call(accept.POST, { body: { token: inv.token, password: PW } })).json.token;
    const mine = (await call(tickets.GET, { token: pt })).json.items.map((x: { id: string }) => x.id);
    expect(mine).toContain(ticket.id);
    expect(mine.length).toBe(await prisma.ticket.count({ where: { organizationId: org.id, contactId: ticket.contactId } }));
    const q = (await call(quotes.GET, { token: pt })).json.items.length;
    expect(q).toBe(await prisma.quote.count({ where: { organizationId: org.id, deal: { accountId: ticket.contact!.accountId }, status: { not: 'DRAFT' } } }));
  });
});
