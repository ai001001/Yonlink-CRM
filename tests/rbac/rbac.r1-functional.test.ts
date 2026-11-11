/**
 * 角色权限 第一轮：功能测试（四种角色的权限矩阵、用户管理、演示账号一键登录）。
 * RBAC round 1: functional tests (permission matrix of four roles, user management, demo login).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as adminUsers from '@/app/api/admin/users/route';
import * as adminUserItem from '@/app/api/admin/users/[id]/route';
import * as adminUserPassword from '@/app/api/admin/users/[id]/password/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as loginRoute from '@/app/api/auth/login/route';
import * as me from '@/app/api/auth/me/route';
import * as demoAccounts from '@/app/api/auth/demo-accounts/route';
import * as demoLogin from '@/app/api/auth/demo-login/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
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

const names = async (who: Who, h: typeof leads.GET) => (await call(h, { token: who.token })).json.items.map((x: { name: string }) => x.name).sort();
const mkLead = async (who: Who, body: object) => call(leads.POST, { token: who.token, body });

describe('RBAC R1: me', () => {
  it('/api/auth/me 返回角色与权限 / returns role and permissions', async () => {
    const r = (await call(me.GET, { token: sales1.token })).json;
    expect(r.role).toBe('SALES');
    expect(r.permissions).toEqual(['record.create', 'record.update.own']);
    expect((await call(me.GET, { token: admin.token })).json.permissions).toContain('user.manage');
  });
});

describe('RBAC R1: sales representative', () => {
  it('只看到自己负责的记录（列表、详情、工作台、搜索）/ sees own records only', async () => {
    await mkLead(sales1, { name: '销售1的线索' });
    await mkLead(sales2, { name: '销售2的线索' });
    await mkLead(manager, { name: '经理的线索' });
    expect(await names(sales1, leads.GET)).toEqual(['销售1的线索']);
    expect(await names(manager, leads.GET)).toEqual(['经理的线索', '销售1的线索', '销售2的线索']);
    const other = await prisma.lead.findFirstOrThrow({ where: { name: '销售2的线索' } });
    expect((await call(leadItem.GET, { token: sales1.token, params: { id: other.id } })).status).toBe(404);
    expect((await call(dashboard.GET, { token: sales1.token })).json.counts.leads).toBe(1);
    expect((await call(dashboard.GET, { token: manager.token })).json.counts.leads).toBe(3);
  });

  it('新建记录负责人为自己，不能指派给他人 / owns new records, cannot assign others', async () => {
    const own = await mkLead(sales1, { name: 'x' });
    expect(own.json.ownerId).toBe(sales1.user.id);
    expect((await mkLead(sales1, { name: 'y', ownerId: sales2.user.id })).status).toBe(403);
    expect((await mkLead(sales1, { name: 'z', ownerId: sales1.user.id })).status).toBe(201);
    expect((await call(leadItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: own.json.id }, body: { ownerId: null } })).status).toBe(403);
  });

  it('可编辑自己的记录，不能删除 / edits own records but cannot delete', async () => {
    const own = (await mkLead(sales1, { name: 'x' })).json;
    expect((await call(leadItem.PATCH, { token: sales1.token, method: 'PATCH', params: { id: own.id }, body: { status: 'CONTACTED' } })).status).toBe(200);
    expect((await call(leadItem.DELETE, { token: sales1.token, method: 'DELETE', params: { id: own.id } })).status).toBe(403);
    expect(await prisma.lead.count()).toBe(1);
  });

  it('可转化自己的线索，并只能关联自己可见的客户 / converts own leads into visible accounts', async () => {
    const own = (await mkLead(sales1, { name: 'x', company: '甲公司' })).json;
    const otherAccount = (await call(accounts.POST, { token: sales2.token, body: { name: '销售2的客户' } })).json;
    expect((await call(convert.POST, { token: sales1.token, params: { id: own.id }, body: { account: { mode: 'existing', accountId: otherAccount.id } } })).status).toBe(400);
    const res = await call(convert.POST, { token: sales1.token, params: { id: own.id }, body: { account: { mode: 'new' }, deal: { name: 'd' } } });
    expect(res.status).toBe(200);
    expect(await names(sales1, accounts.GET)).toEqual(['甲公司']);
  });

  it('跟进只能关联自己可见的记录 / activities can only link visible records', async () => {
    const mine = (await call(accounts.POST, { token: sales1.token, body: { name: '我的客户' } })).json;
    const theirs = (await call(accounts.POST, { token: sales2.token, body: { name: '别人的客户' } })).json;
    expect((await call(activities.POST, { token: sales1.token, body: { type: 'CALL', subject: 'x', accountId: mine.id } })).status).toBe(201);
    expect((await call(activities.POST, { token: sales1.token, body: { type: 'CALL', subject: 'x', accountId: theirs.id } })).status).toBe(400);
    expect((await call(deals.POST, { token: sales1.token, body: { name: 'd', accountId: theirs.id } })).status).toBe(400);
  });

  it('不能查看审计日志和管理用户 / no audit or user management', async () => {
    expect((await call(auditLogs.GET, { token: sales1.token })).status).toBe(403);
    expect((await call(adminUsers.GET, { token: sales1.token })).status).toBe(403);
  });
});

describe('RBAC R1: manager', () => {
  it('可查看、编辑、删除、指派全部业务记录 / full business access', async () => {
    const l = (await mkLead(sales1, { name: '销售1的线索' })).json;
    expect((await call(leadItem.PATCH, { token: manager.token, method: 'PATCH', params: { id: l.id }, body: { ownerId: sales2.user.id } })).status).toBe(200);
    expect(await names(sales2, leads.GET)).toEqual(['销售1的线索']);
    expect(await names(sales1, leads.GET)).toEqual([]);
    expect((await call(leadItem.DELETE, { token: manager.token, method: 'DELETE', params: { id: l.id } })).status).toBe(204);
  });

  it('不能查看审计日志和管理用户 / no audit or user management', async () => {
    expect((await call(auditLogs.GET, { token: manager.token })).status).toBe(403);
    expect((await call(adminUsers.POST, { token: manager.token, body: { name: 'x', email: 'x@yonlink.test', role: 'ADMIN', password: 'Passw0rd!long' } })).status).toBe(403);
  });
});

describe('RBAC R1: read-only', () => {
  it('可查看全部，不能新建、编辑、删除、转化 / reads everything, writes nothing', async () => {
    const l = (await mkLead(sales1, { name: '线索' })).json;
    expect(await names(viewer, leads.GET)).toEqual(['线索']);
    expect((await mkLead(viewer, { name: 'x' })).status).toBe(403);
    expect((await call(leadItem.PATCH, { token: viewer.token, method: 'PATCH', params: { id: l.id }, body: { name: 'y' } })).status).toBe(403);
    expect((await call(leadItem.DELETE, { token: viewer.token, method: 'DELETE', params: { id: l.id } })).status).toBe(403);
    expect((await call(convert.POST, { token: viewer.token, params: { id: l.id }, body: { account: { mode: 'new' } } })).status).toBe(403);
    expect((await call(activities.POST, { token: viewer.token, body: { type: 'CALL', subject: 'x' } })).status).toBe(403);
  });
});

describe('RBAC R1: admin user management', () => {
  it('新建用户（可用新密码登录）、改角色立即生效、停用、重置密码 / create, change role, deactivate, reset', async () => {
    const created = await call(adminUsers.POST, { token: admin.token, body: { name: '新同事', email: 'New.User@yonlink.test', role: 'SALES', password: 'Initial-Pass-123' } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ email: 'new.user@yonlink.test', role: 'SALES', isActive: true });
    expect(created.json).not.toHaveProperty('passwordHash');
    const login = await call(loginRoute.POST, { body: { email: 'new.user@yonlink.test', password: 'Initial-Pass-123' } });
    expect(login.status).toBe(200);

    // 改角色：同一令牌下一个请求立即生效 / role change applies on the very next request
    expect((await call(me.GET, { token: login.json.token })).json.role).toBe('SALES');
    await call(adminUserItem.PATCH, { token: admin.token, method: 'PATCH', params: { id: created.json.id }, body: { role: 'MANAGER' } });
    expect((await call(me.GET, { token: login.json.token })).json.role).toBe('MANAGER');

    // 重置密码：旧会话失效，新密码可登录 / reset: old sessions revoked, new password works
    expect((await call(adminUserPassword.POST, { token: admin.token, params: { id: created.json.id }, body: { password: 'Another-Pass-456' } })).status).toBe(204);
    expect((await call(me.GET, { token: login.json.token })).status).toBe(401);
    expect((await call(loginRoute.POST, { body: { email: 'new.user@yonlink.test', password: 'Another-Pass-456' } })).status).toBe(200);

    // 停用：无法登录 / deactivated users cannot sign in
    await call(adminUserItem.PATCH, { token: admin.token, method: 'PATCH', params: { id: created.json.id }, body: { isActive: false } });
    expect((await call(loginRoute.POST, { body: { email: 'new.user@yonlink.test', password: 'Another-Pass-456' } })).status).toBe(401);

    const list = (await call(adminUsers.GET, { token: admin.token })).json.items;
    expect(list).toHaveLength(6);
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'user' }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(actions).toEqual(['user.create', 'user.update', 'user.reset_password', 'user.update']);
  });

  it('管理员可查看审计日志 / admins read audit logs', async () => {
    expect((await call(auditLogs.GET, { token: admin.token })).status).toBe(200);
  });
});

describe('RBAC R1: demo one-click login', () => {
  const prev = process.env.DEMO_LOGIN_ENABLED;
  afterEach(() => {
    process.env.DEMO_LOGIN_ENABLED = prev;
  });

  it('开启时列出演示账号并可一键登录，记录审计 / lists demo accounts and logs in when enabled', async () => {
    process.env.DEMO_LOGIN_ENABLED = '1';
    await prisma.user.update({ where: { id: sales1.user.id }, data: { isDemo: true } });
    const list = await call(demoAccounts.GET);
    expect(list.status).toBe(200);
    expect(list.json.items.map((u: { id: string }) => u.id)).toEqual([sales1.user.id]);
    expect(list.json.items[0]).not.toHaveProperty('passwordHash');
    const res = await call(demoLogin.POST, { body: { userId: sales1.user.id } });
    expect(res.status).toBe(200);
    expect((await call(me.GET, { token: res.json.token })).json.role).toBe('SALES');
    expect(await prisma.auditLog.count({ where: { action: 'auth.demo_login', actorId: sales1.user.id } })).toBe(1);
  });

  it('默认关闭：两个接口均 404 / disabled by default: both endpoints 404', async () => {
    delete process.env.DEMO_LOGIN_ENABLED;
    await prisma.user.update({ where: { id: sales1.user.id }, data: { isDemo: true } });
    expect((await call(demoAccounts.GET)).status).toBe(404);
    expect((await call(demoLogin.POST, { body: { userId: sales1.user.id } })).status).toBe(404);
  });
});
