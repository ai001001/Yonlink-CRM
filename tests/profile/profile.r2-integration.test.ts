/**
 * 个人设置 第二轮：集成测试（演示账号不能设密码且免密登录不受影响、当前密码错误限流、不能借接口改角色或邮箱、
 * 登录记录只含本人、退出其他设备不影响他人、各角色可用、参数校验、未登录、跨域预检）。
 * Profile round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed-demo';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import * as demoLogin from '@/app/api/auth/demo-login/route';
import * as login from '@/app/api/auth/login/route';
import * as me from '@/app/api/auth/me/route';
import * as password from '@/app/api/profile/password/route';
import * as profile from '@/app/api/profile/route';
import * as revoke from '@/app/api/profile/sessions/revoke-others/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
const NEW = 'NewPassw0rd!2026';

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

describe('profile R2 security', () => {
  it('演示账号不能设置密码，免密登录仍可用 / demo accounts cannot set a password', async () => {
    const saved = process.env.DEMO_LOGIN_ENABLED;
    process.env.DEMO_LOGIN_ENABLED = '1';
    try {
      await seedDemo({ reset: true });
      const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
      const demo = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'SALES', isDemo: true } });
      const before = demo.passwordHash;
      const session = await call(demoLogin.POST, { body: { userId: demo.id } });
      expect(session.status).toBe(200);
      const r = await call(password.POST, { token: session.json.token, body: { currentPassword: 'anything', newPassword: NEW } });
      expect(r.status).toBe(403);
      expect(r.json.error.details).toEqual({ currentPassword: ['demo'] });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: demo.id } })).passwordHash).toBe(before);
      expect((await call(login.POST, { body: { email: demo.email, password: NEW } })).status).toBe(401);
      expect((await call(profile.GET, { token: session.json.token })).json.user.isDemo).toBe(true);
    } finally {
      process.env.DEMO_LOGIN_ENABLED = saved;
    }
  });

  it('当前密码连续错误 5 次后锁定 15 分钟（正确密码也拒绝），不影响他人 / rate limit', async () => {
    for (let i = 0; i < 5; i++) expect((await call(password.POST, { token: a.token, body: { currentPassword: `wrong-${i}`, newPassword: NEW } })).status).toBe(400);
    const locked = await call(password.POST, { token: a.token, body: { currentPassword: a.password, newPassword: NEW } });
    expect(locked.status).toBe(429);
    expect((await call(login.POST, { body: { email: a.user.email, password: a.password } })).status).toBe(200);
    expect((await call(password.POST, { token: b.token, body: { currentPassword: b.password, newPassword: NEW } })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'user.change_password_failed', entityId: a.user.id } })).toBe(5);
  });

  it('不能借个人设置改角色、邮箱或组织 / no privilege changes through the profile', async () => {
    const sales = await addUser(a.org.id, 'SALES', 'S');
    for (const body of [{ name: 'x', role: 'ADMIN' }, { name: 'x', email: 'evil@example.com' }, { name: 'x', organizationId: b.org.id }, { role: 'ADMIN' }, { isActive: false }]) {
      expect((await call(profile.PATCH, { token: sales.token, body, method: 'PATCH' })).status).toBe(400);
    }
    expect((await call(password.POST, { token: sales.token, body: { currentPassword: 'x', newPassword: NEW, userId: a.user.id } })).status).toBe(400);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: sales.user.id } });
    expect(row).toMatchObject({ role: 'SALES', organizationId: a.org.id, isActive: true });
  });

  it('登录记录只含本人；退出其他设备不影响他人 / own history only', async () => {
    await call(login.POST, { body: { email: a.user.email, password: a.password } });
    await call(login.POST, { body: { email: b.user.email, password: 'wrong-password' } });
    await call(login.POST, { body: { email: b.user.email, password: b.password } });
    const mine = (await call(profile.GET, { token: a.token })).json;
    expect(mine.loginHistory.map((h: { action: string }) => h.action)).toEqual(['auth.login']);
    const theirs = (await call(profile.GET, { token: b.token })).json;
    expect(theirs.loginHistory.map((h: { action: string }) => h.action)).toEqual(['auth.login', 'auth.login_failed']);
    expect((await call(revoke.POST, { token: a.token })).json).toEqual({ revokedSessions: 1 });
    expect((await call(me.GET, { token: b.token })).status).toBe(200);
  });
});

describe('profile R2 roles & validation', () => {
  it('各角色（含只读）都能查看个人设置并修改自己的密码 / every role can use the profile', async () => {
    const viewer = await addUser(a.org.id, 'READONLY', 'V');
    await prisma.user.update({ where: { id: viewer.user.id }, data: { passwordHash: (await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).passwordHash } });
    expect((await call(profile.GET, { token: viewer.token })).status).toBe(200);
    expect((await call(profile.PATCH, { token: viewer.token, body: { name: '只读新名' }, method: 'PATCH' })).status).toBe(200);
    expect((await call(password.POST, { token: viewer.token, body: { currentPassword: a.password, newPassword: NEW } })).status).toBe(200);
  });

  it('参数校验与未登录 / validation and auth', async () => {
    for (const body of [{}, { name: '  ' }, { name: 'x'.repeat(101) }]) expect((await call(profile.PATCH, { token: a.token, body, method: 'PATCH' })).status).toBe(400);
    for (const body of [{}, { currentPassword: '', newPassword: NEW }, { currentPassword: a.password }, { currentPassword: a.password, newPassword: 'x'.repeat(201) }]) {
      expect((await call(password.POST, { token: a.token, body })).status).toBe(400);
    }
    expect((await call(profile.GET)).status).toBe(401);
    expect((await call(password.POST, { body: { currentPassword: a.password, newPassword: NEW } })).status).toBe(401);
    expect((await call(revoke.POST)).status).toBe(401);
    expect((await call(login.POST, { body: { email: a.user.email, password: a.password } })).status).toBe(200);
  });
});

describe('profile R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET/PATCH/POST / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await profile.OPTIONS(new Request('http://localhost/api/profile', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    for (const m of ['GET', 'PATCH', 'POST']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
  });
});
