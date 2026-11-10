/**
 * 认证基础测试 / Authentication tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as loginRoute from '@/app/api/auth/login/route';
import * as logoutRoute from '@/app/api/auth/logout/route';
import * as meRoute from '@/app/api/auth/me/route';
import * as usersRoute from '@/app/api/users/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

beforeEach(resetDb);

describe('auth', () => {
  it('登录成功返回令牌，数据库只存哈希 / login returns a token and only its hash is stored', async () => {
    const a = await createTenant('A');
    const res = await call(loginRoute.POST, { body: { email: a.user.email.toUpperCase(), password: a.password } });
    expect(res.status).toBe(200);
    expect(res.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await prisma.session.findMany({ where: { userId: a.user.id } });
    expect(rows.some((s) => s.tokenHash === res.json.token)).toBe(false);
    const me = await call(meRoute.GET, { token: res.json.token });
    expect(me.status).toBe(200);
    expect(me.json.organization.id).toBe(a.org.id);
  });

  it('错误密码与不存在用户返回相同错误 / wrong password and unknown user look identical', async () => {
    const a = await createTenant('A');
    const wrong = await call(loginRoute.POST, { body: { email: a.user.email, password: 'nope' } });
    const unknown = await call(loginRoute.POST, { body: { email: 'ghost@yonlink.test', password: 'nope' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error.code).toBe(unknown.json.error.code);
  });

  it('连续失败触发限流 / repeated failures are rate limited', async () => {
    const a = await createTenant('A');
    for (let i = 0; i < 10; i++) await call(loginRoute.POST, { body: { email: a.user.email, password: 'bad' } });
    const res = await call(loginRoute.POST, { body: { email: a.user.email, password: a.password } });
    expect(res.status).toBe(429);
  });

  it('停用用户无法登录且现有会话失效 / inactive users cannot sign in and sessions stop working', async () => {
    const a = await createTenant('A');
    await prisma.user.update({ where: { id: a.user.id }, data: { isActive: false } });
    expect((await call(loginRoute.POST, { body: { email: a.user.email, password: a.password } })).status).toBe(401);
    expect((await call(meRoute.GET, { token: a.token })).status).toBe(401);
  });

  it('过期会话与注销后的会话被拒绝 / expired and logged-out sessions are rejected', async () => {
    const a = await createTenant('A');
    await call(logoutRoute.POST, { token: a.token, method: 'POST' });
    expect((await call(meRoute.GET, { token: a.token })).status).toBe(401);

    const b = await createTenant('B');
    await prisma.session.updateMany({ where: { userId: b.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(meRoute.GET, { token: b.token })).status).toBe(401);
  });

  it('未携带或伪造令牌返回 401 / missing or forged tokens yield 401', async () => {
    expect((await call(meRoute.GET)).status).toBe(401);
    expect((await call(meRoute.GET, { token: 'x'.repeat(43) })).status).toBe(401);
  });

  it('用户列表只返回本组织用户 / user list is organization scoped', async () => {
    const a = await createTenant('A');
    await createTenant('B');
    const res = await call(usersRoute.GET, { token: a.token });
    expect(res.json.items.map((u: { id: string }) => u.id)).toEqual([a.user.id]);
    expect(res.json.items[0]).not.toHaveProperty('passwordHash');
  });
});
