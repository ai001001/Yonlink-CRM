/**
 * 自定义角色 第一轮：功能测试（列表与目录；新建校验：名称、基础角色、未知与只属于管理员的权限、重复；上限；修改与审计；
 * 分配：基础角色须一致、只改角色时清除不一致的自定义角色、管理员不能套用、不能改自己；生效：/me 返回有效权限，
 * 授予的权限立即可用、撤销立即失效；删除：使用中 409）。
 * Custom roles round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as me from '@/app/api/auth/me/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as roleItem from '@/app/api/roles/[id]/route';
import * as roles from '@/app/api/roles/route';
import * as userItem from '@/app/api/admin/users/[id]/route';
import * as users from '@/app/api/admin/users/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;

const newRole = (body: object, token = a.token) => call(roles.POST, { token, body: { name: '大客户代表', baseRole: 'SALES', permissions: ['record.create', 'record.update.own'], ...body } });
const patchUser = (id: string, body: object, token = a.token) => call(userItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const exportStatus = async (token: string) => (await leadExport.GET(new Request('http://localhost/x', { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) })).status;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('custom roles R1 maintenance', () => {
  it('列表、目录、新建校验、上限、修改、审计 / list, catalogue, validation, cap, update, audit', async () => {
    const list = (await call(roles.GET, { token: a.token })).json;
    expect(list.system.map((x: { role: string }) => x.role)).toEqual(['ADMIN', 'MANAGER', 'SALES', 'READONLY']);
    expect(list.grantable).toContain('data.export');
    expect(list.grantable).not.toContain('user.manage');
    expect(list.grantable).not.toContain('integration.manage');
    expect(list.custom).toEqual([]);
    for (const u of [mgr, sales]) expect((await call(roles.GET, { token: u.token })).status).toBe(403);
    const r = await newRole({ description: '可导出的销售', permissions: ['record.create', 'record.update.own', 'data.export'] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '大客户代表', baseRole: 'SALES', permissions: ['record.create', 'record.update.own', 'data.export'], _count: { users: 0 } });
    const bad: [object, string][] = [
      [{ name: ' ' }, 'name'],
      [{ name: '管理员副本', baseRole: 'ADMIN' }, 'baseRole'],
      [{ name: '未知权限', permissions: ['record.fly'] }, 'permissions'],
      [{ name: '提权', permissions: ['user.manage'] }, 'permissions'],
      [{ name: '集成', permissions: ['integration.manage'] }, 'permissions'],
      [{ name: '重复', permissions: ['record.create', 'record.create'] }, 'permissions'],
    ];
    for (const [body, key] of bad) {
      const res = await newRole(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(Object.keys(res.json.error.details).some((k) => k.startsWith(key))).toBe(true);
    }
    expect((await newRole({ name: ' 大客户代表 ' })).json.error.details).toEqual({ name: ['taken'] });
    expect((await newRole({ name: '经理建的' }, mgr.token)).status).toBe(403);
    // 修改：权限增减与审计 / update: permission changes and audit
    const up = await call(roleItem.PATCH, { token: a.token, params: { id: r.json.id }, body: { permissions: ['record.create', 'record.update.own', 'record.read.all'] }, method: 'PATCH' });
    expect(up.json.permissions).toEqual(['record.create', 'record.update.own', 'record.read.all']);
    expect((await call(roleItem.PATCH, { token: a.token, params: { id: r.json.id }, body: { baseRole: 'MANAGER' }, method: 'PATCH' })).status).toBe(400);
    const logs = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entityType: 'role' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['role.create', 'role.update']);
    expect(logs[1]!.changes).toMatchObject({ added: ['record.read.all'], removed: ['data.export'] });
    // 上限 30 / cap of 30
    for (let i = 0; i < 29; i++) expect((await newRole({ name: `角色${i}` })).status).toBe(201);
    expect((await newRole({ name: '第三十一个' })).json.error.details).toEqual({ name: ['limit_reached'] });
  });
});

describe('custom roles R1 assignment and effect', () => {
  it('分配规则与立即生效 / assignment rules and immediate effect', async () => {
    const exporter = (await newRole({ name: '可导出销售', permissions: ['record.create', 'record.update.own', 'data.export'] })).json;
    const viewer = (await newRole({ name: '受限只读', baseRole: 'READONLY', permissions: ['record.read.all'] })).json;
    // 基础角色须一致；管理员不能套用 / base roles must match; admins never carry a custom role
    expect((await patchUser(sales.user.id, { customRoleId: viewer.id })).json.error.details).toEqual({ customRoleId: ['role_mismatch'] });
    expect((await patchUser(sales.user.id, { role: 'ADMIN', customRoleId: exporter.id })).json.error.details).toEqual({ customRoleId: ['role_mismatch'] });
    expect((await patchUser(a.user.id, { customRoleId: exporter.id })).json.error.details).toEqual({ user: ['self'] });
    expect((await patchUser(sales.user.id, { customRoleId: crypto.randomUUID() })).json.error.details).toEqual({ customRoleId: ['not_found'] });
    // 销售原本不能导出 / sales cannot export by default
    expect(await exportStatus(sales.token)).toBe(403);
    const assigned = await patchUser(sales.user.id, { customRoleId: exporter.id });
    expect(assigned.json).toMatchObject({ role: 'SALES', customRole: { id: exporter.id, name: '可导出销售' } });
    const meRes = (await call(me.GET, { token: sales.token })).json;
    expect(meRes.customRole).toEqual({ id: exporter.id, name: '可导出销售' });
    expect(meRes.permissions).toContain('data.export');
    expect(await exportStatus(sales.token)).toBe(200);
    // 撤销权限立即生效 / revocation applies at once
    await call(roleItem.PATCH, { token: a.token, params: { id: exporter.id }, body: { permissions: ['record.create', 'record.update.own'] }, method: 'PATCH' });
    expect(await exportStatus(sales.token)).toBe(403);
    // 受限只读：去掉采购查看 / restricted read-only: purchase viewing removed
    const ro = await addUser(a.org.id, 'READONLY', '只读');
    expect((await call(me.GET, { token: ro.token })).json.permissions).toContain('purchase.read');
    await patchUser(ro.user.id, { customRoleId: viewer.id });
    expect((await call(me.GET, { token: ro.token })).json.permissions).toEqual(['record.read.all']);
    // 只改角色：基础角色不同则清除自定义角色 / changing the role alone clears a mismatching custom role
    const changed = await patchUser(sales.user.id, { role: 'MANAGER' });
    expect(changed.json).toMatchObject({ role: 'MANAGER', customRoleId: null });
    expect((await call(me.GET, { token: sales.token })).json.permissions).toContain('record.delete');
    // 新建用户时指定 / assign on creation
    const created = await call(users.POST, { token: a.token, body: { name: '新人', email: 'new@yonlink.test', role: 'READONLY', customRoleId: viewer.id, password: 'Passw0rd!long' } });
    expect(created.json.customRole).toEqual({ id: viewer.id, name: '受限只读' });
    // 授予读取全部的销售角色：能看到他人的客户 / a sales role with read-all sees others' accounts
    const reader = (await newRole({ name: '可读全部的销售', permissions: ['record.create', 'record.update.own', 'record.read.all'] })).json;
    const s2 = await addUser(a.org.id, 'SALES', '销售二');
    await call(accounts.POST, { token: a.token, body: { name: '管理员的客户' } });
    expect((await call(accounts.GET, { token: s2.token })).json.total).toBe(0);
    await patchUser(s2.user.id, { customRoleId: reader.id });
    expect((await call(accounts.GET, { token: s2.token })).json.total).toBe(1);
    // 用户审计记录自定义角色 / the user audit records the custom role
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'user', entityId: s2.user.id, action: 'user.update' } });
    expect(log.changes).toMatchObject({ fields: { customRoleId: [null, reader.id] } });
  });

  it('删除：使用中 409，空闲可删 / delete: 409 while in use', async () => {
    const r = (await newRole({ name: '临时角色' })).json;
    await patchUser(sales.user.id, { customRoleId: r.id });
    expect((await call(roleItem.DELETE, { token: a.token, params: { id: r.id }, method: 'DELETE' })).json.error.details).toEqual({ role: ['in_use'] });
    await patchUser(sales.user.id, { customRoleId: null });
    expect((await call(roleItem.DELETE, { token: a.token, params: { id: r.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(roleItem.DELETE, { token: a.token, params: { id: r.id }, method: 'DELETE' })).status).toBe(404);
  });
});
