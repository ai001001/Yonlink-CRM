/**
 * 个人设置 第一轮：功能测试（个人信息与会话、修改名称、修改密码后其他会话失效与新旧密码、当前密码错误与相同密码、
 * 退出其他设备、登录记录、审计不含密码）。
 * Profile round 1: functional tests.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as login from '@/app/api/auth/login/route';
import * as me from '@/app/api/auth/me/route';
import * as password from '@/app/api/profile/password/route';
import * as profile from '@/app/api/profile/route';
import * as revoke from '@/app/api/profile/sessions/revoke-others/route';
import { hashToken } from '@/server/auth';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const NEW = 'NewPassw0rd!2026';

/** 为同一用户再开一个会话（模拟另一台设备）/ open another session for the user (another device) */
async function otherDevice(userId: string) {
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return token;
}
const signIn = (email: string, pw: string) => call(login.POST, { body: { email, password: pw } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('profile R1', () => {
  it('个人信息、会话（标出当前设备）与登录记录 / profile, sessions and sign-ins', async () => {
    await signIn(a.user.email, 'wrong-password');
    const second = (await signIn(a.user.email, a.password)).json.token as string;
    expect(second).toBeTruthy();
    const r = await call(profile.GET, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ id: a.user.id, name: a.user.name, email: a.user.email, role: 'ADMIN', isDemo: false, organization: { id: a.org.id } });
    expect(r.json.user.passwordHash).toBeUndefined();
    expect(r.json.sessions).toHaveLength(2);
    expect(r.json.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(r.json)).not.toContain(hashToken(a.token));
    expect(r.json.loginHistory.map((h: { action: string }) => h.action)).toEqual(['auth.login', 'auth.login_failed']);
    expect(r.json.loginHistory[1]).toMatchObject({ reason: 'bad_password' });
  });

  it('修改显示名称：生效并写审计，名称不变不写 / rename', async () => {
    const r = await call(profile.PATCH, { token: a.token, body: { name: '新名字' }, method: 'PATCH' });
    expect(r.status).toBe(200);
    expect(r.json.user.name).toBe('新名字');
    expect((await call(me.GET, { token: a.token })).json.name).toBe('新名字');
    await call(profile.PATCH, { token: a.token, body: { name: '新名字' }, method: 'PATCH' });
    const logs = await prisma.auditLog.findMany({ where: { action: 'user.update', entityId: a.user.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.changes).toEqual({ fields: { name: [a.user.name, '新名字'] }, via: 'user.profile' });
  });

  it('修改密码：当前设备保留、其他设备失效、新密码可登录旧密码不行、审计不含密码 / change password', async () => {
    const other = await otherDevice(a.user.id);
    const r = await call(password.POST, { token: a.token, body: { currentPassword: a.password, newPassword: NEW } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ revokedSessions: 1 });
    expect((await call(me.GET, { token: a.token })).status).toBe(200);
    expect((await call(me.GET, { token: other })).status).toBe(401);
    expect((await signIn(a.user.email, a.password)).status).toBe(401);
    expect((await signIn(a.user.email, NEW)).status).toBe(200);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.change_password' } });
    expect(log.changes).toEqual({ revokedSessions: 1 });
    const all = JSON.stringify(await prisma.auditLog.findMany());
    expect(all).not.toContain(NEW);
    expect(all).not.toContain(a.password);
  });

  it('当前密码错误 400 并写审计；新旧相同、过短 400；均不改密码 / rejected changes', async () => {
    const wrong = await call(password.POST, { token: a.token, body: { currentPassword: 'not-my-password', newPassword: NEW } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.details).toEqual({ currentPassword: ['incorrect'] });
    expect(await prisma.auditLog.count({ where: { action: 'user.change_password_failed', entityId: a.user.id } })).toBe(1);
    const same = await call(password.POST, { token: a.token, body: { currentPassword: a.password, newPassword: a.password } });
    expect(same.status).toBe(400);
    expect(same.json.error.details).toEqual({ newPassword: ['same'] });
    expect((await call(password.POST, { token: a.token, body: { currentPassword: a.password, newPassword: 'short' } })).status).toBe(400);
    expect((await signIn(a.user.email, a.password)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'user.change_password' } })).toBe(0);
  });

  it('退出其他设备：只保留当前会话并写审计，出现在登录记录中 / sign out other devices', async () => {
    const o1 = await otherDevice(a.user.id);
    const o2 = await otherDevice(a.user.id);
    const someoneElse = await addUser(a.org.id, 'SALES');
    const r = await call(revoke.POST, { token: a.token });
    expect(r.json).toEqual({ revokedSessions: 2 });
    for (const tok of [o1, o2]) expect((await call(me.GET, { token: tok })).status).toBe(401);
    expect((await call(me.GET, { token: a.token })).status).toBe(200);
    expect((await call(me.GET, { token: someoneElse.token })).status).toBe(200);
    const p = (await call(profile.GET, { token: a.token })).json;
    expect(p.sessions).toHaveLength(1);
    expect(p.loginHistory[0]).toMatchObject({ action: 'auth.logout_others' });
  });
});
