/**
 * 角色权限 第二轮：集成测试（越权/提权、最后管理员保护与并发、跨组织、可见范围绕过、演示登录边界）。
 * RBAC round 2: integration tests (privilege escalation, last-admin protection incl. concurrency,
 * cross-organization, visibility bypass attempts, demo login edge cases).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as activities from '@/app/api/activities/route';
import * as activityItem from '@/app/api/activities/[id]/route';
import * as adminUsers from '@/app/api/admin/users/route';
import * as adminUserItem from '@/app/api/admin/users/[id]/route';
import * as adminUserPassword from '@/app/api/admin/users/[id]/password/route';
import * as me from '@/app/api/auth/me/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as demoLogin from '@/app/api/auth/demo-login/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as search from '@/app/api/search/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let sales1: Who;
let sales2: Who;
let manager: Who;
beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  manager = await addUser(admin.org.id, 'MANAGER');
});

const patchUser = (who: Who, id: string, body: object) => call(adminUserItem.PATCH, { token: who.token, method: 'PATCH', params: { id }, body });

describe('RBAC R2 privilege escalation', () => {
  it('非管理员不能修改任何人的角色（包括自己）/ non-admins cannot change roles, including their own', async () => {
    expect((await patchUser(sales1, sales1.user.id, { role: 'ADMIN' })).status).toBe(403);
    expect((await patchUser(manager, sales1.user.id, { role: 'ADMIN' })).status).toBe(403);
    expect((await call(adminUserPassword.POST, { token: manager.token, params: { id: admin.user.id }, body: { password: 'Hijack-Pass-123' } })).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: sales1.user.id } })).role).toBe('SALES');
  });

  it.each([
    ['注入 isDemo / inject isDemo', { name: 'x', email: 'a@yonlink.test', role: 'SALES', password: 'Long-Enough-1', isDemo: true }],
    ['注入 organizationId', { name: 'x', email: 'a@yonlink.test', role: 'SALES', password: 'Long-Enough-1', organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['非法角色 / bad role', { name: 'x', email: 'a@yonlink.test', role: 'ROOT', password: 'Long-Enough-1' }],
    ['密码过短 / short password', { name: 'x', email: 'a@yonlink.test', role: 'SALES', password: 'short' }],
    ['邮箱非法 / bad email', { name: 'x', email: 'nope', role: 'SALES', password: 'Long-Enough-1' }],
    ['缺姓名 / missing name', { email: 'a@yonlink.test', role: 'SALES', password: 'Long-Enough-1' }],
  ])('新建用户 %s → 400', async (_l, body) => {
    expect((await call(adminUsers.POST, { token: admin.token, body })).status).toBe(400);
    expect(await prisma.user.count()).toBe(4);
  });

  it.each([[{ email: 'x@yonlink.test' }], [{ password: 'Long-Enough-1' }], [{ isDemo: true }], [{ role: 'ROOT' }], [{ isActive: 'no' }]])(
    '更新用户非法字段 %j → 400',
    async (body) => {
      expect((await patchUser(admin, sales1.user.id, body)).status).toBe(400);
    },
  );

  it('邮箱重复 → 409（不区分大小写）/ duplicate email → 409', async () => {
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: sales1.user.id } })).email.toUpperCase();
    expect((await call(adminUsers.POST, { token: admin.token, body: { name: 'x', email, role: 'SALES', password: 'Long-Enough-1' } })).status).toBe(409);
  });

  it('销售代表即使带 ownerId 筛选也看不到他人数据 / visibility cannot be bypassed with an ownerId filter', async () => {
    await call(leads.POST, { token: sales2.token, body: { name: '销售2的线索' } });
    const res = await call(leads.GET, { token: sales1.token, query: { ownerId: sales2.user.id } });
    expect(res.json.total).toBe(0);
    for (const h of [accounts.GET, deals.GET, activities.GET]) {
      expect((await call(h, { token: sales1.token, query: { ownerId: sales2.user.id } })).json.total).toBe(0);
    }
  });

  it('未分配负责人的记录对销售代表不可见 / unassigned records are invisible to sales reps', async () => {
    await call(leads.POST, { token: manager.token, body: { name: '未分配', ownerId: null } });
    expect((await call(leads.GET, { token: sales1.token })).json.total).toBe(0);
    expect((await call(leads.GET, { token: manager.token })).json.total).toBe(1);
  });

  it('销售代表对他人记录的读/改/删：404/404/403，数据不变 / IDOR between sales reps', async () => {
    const l = (await call(leads.POST, { token: sales2.token, body: { name: '销售2的线索' } })).json;
    expect((await call(leadItem.GET, { token: sales1.token, params: { id: l.id } })).status).toBe(404);
    expect((await call(leadItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: l.id }, body: { name: '篡改' } })).status).toBe(404);
    expect((await call(leadItem.DELETE, { token: sales1.token, method: 'DELETE', params: { id: l.id } })).status).toBe(403);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).name).toBe('销售2的线索');
  });

  it('联系人与跟进同样受可见范围约束 / contacts and activities follow visibility', async () => {
    const acc = (await call(accounts.POST, { token: sales2.token, body: { name: '销售2的客户' } })).json;
    const c = (await call(accountContacts.POST, { token: sales2.token, params: { id: acc.id }, body: { name: '联系人' } })).json;
    const a = (await call(activities.POST, { token: sales2.token, body: { type: 'CALL', subject: '销售2的电话', accountId: acc.id } })).json;
    expect((await call(accountContacts.GET, { token: sales1.token, params: { id: acc.id } })).status).toBe(404);
    expect((await call(accountContacts.POST, { token: sales1.token, params: { id: acc.id }, body: { name: '入侵' } })).status).toBe(404);
    expect((await call(contactItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: c.id }, body: { name: '篡改' } })).status).toBe(404);
    expect((await call(activityItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: a.id }, body: { completed: true } })).status).toBe(404);
    expect((await call(activities.GET, { token: sales1.token, query: { accountId: acc.id } })).json.total).toBe(0);
    expect(await prisma.contact.count()).toBe(1);
  });

  it('商机金额合计与全局搜索按可见范围 / deal totals and global search follow visibility', async () => {
    const a1 = (await call(accounts.POST, { token: sales1.token, body: { name: '共同关键字甲' } })).json;
    const a2 = (await call(accounts.POST, { token: sales2.token, body: { name: '共同关键字乙' } })).json;
    await call(deals.POST, { token: sales1.token, body: { name: 'd1', accountId: a1.id, amount: '100' } });
    await call(deals.POST, { token: sales2.token, body: { name: 'd2', accountId: a2.id, amount: '900' } });
    expect((await call(deals.GET, { token: sales1.token })).json.sums).toEqual([{ currency: 'CNY', amount: '100' }]);
    expect((await call(deals.GET, { token: manager.token })).json.sums).toEqual([{ currency: 'CNY', amount: '1000' }]);
    const r = (await call(search.GET, { token: sales1.token, query: { q: '共同关键字' } })).json;
    expect(r.accounts.map((x: { name: string }) => x.name)).toEqual(['共同关键字甲']);
  });
});

describe('RBAC R2 last-admin protection', () => {
  it('不能修改自己的角色或停用自己 / cannot change own role or deactivate self', async () => {
    expect((await patchUser(admin, admin.user.id, { role: 'SALES' })).status).toBe(409);
    expect((await patchUser(admin, admin.user.id, { isActive: false })).status).toBe(409);
    expect((await patchUser(admin, admin.user.id, { name: '改名可以' })).status).toBe(200);
  });

  it('两名管理员时可降级其一；并发互相降级后至少保留一名 / concurrent mutual demotion keeps an admin', async () => {
    const admin2 = await addUser(admin.org.id, 'ADMIN', 'A2');
    const results = await Promise.all([patchUser(admin, admin2.user.id, { role: 'SALES' }), patchUser(admin2, admin.user.id, { role: 'SALES' })]);
    const statuses = results.map((r) => r.status).sort();
    // 第二个请求要么因已被降级而 403，要么因“最后一名管理员”而 409 / the loser gets 403 (already demoted) or 409 (last admin)
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect(await prisma.user.count({ where: { organizationId: admin.org.id, role: 'ADMIN', isActive: true } })).toBe(1);
  });

  it('停用用户后其现有会话立即失效 / deactivation invalidates existing sessions immediately', async () => {
    expect((await call(me.GET, { token: sales1.token })).status).toBe(200);
    await patchUser(admin, sales1.user.id, { isActive: false });
    expect((await call(me.GET, { token: sales1.token })).status).toBe(401);
    expect(await prisma.session.count({ where: { userId: sales1.user.id } })).toBe(0);
  });
});

describe('RBAC R2 cross-organization', () => {
  it('其他组织管理员看不到、改不了本组织用户 / admins of another org cannot see or change users', async () => {
    const other = await createTenant('B', 'ADMIN');
    const list = (await call(adminUsers.GET, { token: other.token })).json.items;
    expect(list.map((u: { id: string }) => u.id)).toEqual([other.user.id]);
    expect((await patchUser(other, sales1.user.id, { role: 'ADMIN' })).status).toBe(404);
    expect((await call(adminUserPassword.POST, { token: other.token, params: { id: sales1.user.id }, body: { password: 'Hijack-Pass-123' } })).status).toBe(404);
  });

  it('用户管理审计记录：邮箱打码、不含密码 / user audit entries mask email and omit passwords', async () => {
    await call(adminUsers.POST, { token: admin.token, body: { name: '审计', email: 'secret.person@yonlink.test', role: 'SALES', password: 'Super-Secret-789' } });
    const dump = JSON.stringify(await prisma.auditLog.findMany({ where: { entityType: 'user' } }));
    expect(dump).toContain('s***@yonlink.test');
    expect(dump).not.toContain('secret.person@yonlink.test');
    expect(dump).not.toContain('Super-Secret-789');
  });
});

describe('RBAC R2 demo login edge cases', () => {
  const prev = process.env.DEMO_LOGIN_ENABLED;
  beforeEach(() => {
    process.env.DEMO_LOGIN_ENABLED = '1';
  });
  afterEach(() => {
    process.env.DEMO_LOGIN_ENABLED = prev;
  });

  it('非演示账号、停用的演示账号不能一键登录 / non-demo and inactive demo users are rejected', async () => {
    expect((await call(demoLogin.POST, { body: { userId: admin.user.id } })).status).toBe(401);
    await prisma.user.update({ where: { id: sales1.user.id }, data: { isDemo: true, isActive: false } });
    expect((await call(demoLogin.POST, { body: { userId: sales1.user.id } })).status).toBe(401);
    expect(await prisma.session.count({ where: { userId: { in: [admin.user.id, sales1.user.id] } } })).toBe(2);
  });

  it.each([[{}], [{ userId: 'x' }], [{ userId: '00000000-0000-4000-8000-000000000000', role: 'ADMIN' }]])('非法请求 %j → 400', async (body) => {
    expect((await call(demoLogin.POST, { body })).status).toBe(400);
  });

  it('演示账号的权限与其角色一致（不因演示而放宽）/ demo users get exactly their role permissions', async () => {
    await prisma.user.update({ where: { id: sales1.user.id }, data: { isDemo: true } });
    const token = (await call(demoLogin.POST, { body: { userId: sales1.user.id } })).json.token;
    expect((await call(adminUsers.GET, { token })).status).toBe(403);
    const l = (await call(leads.POST, { token: sales2.token, body: { name: '别人的' } })).json;
    expect((await call(leadItem.GET, { token, params: { id: l.id } })).status).toBe(404);
  });
});
