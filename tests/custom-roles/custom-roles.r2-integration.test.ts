/**
 * 自定义角色 第二轮：集成测试（并发新建不超上限；删除与分配并发时不出现悬空引用；数据库约束与跨组织外键；
 * 去掉权限后各接口实际拒绝（删除、采购单、工作流维护）；API 密钥按其用户的自定义角色；最后一名管理员规则不受影响；演示数据）。
 * Custom roles round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as userItem from '@/app/api/admin/users/[id]/route';
import * as me from '@/app/api/auth/me/route';
import * as purchaseOrders from '@/app/api/purchase-orders/route';
import * as roleItem from '@/app/api/roles/[id]/route';
import * as roles from '@/app/api/roles/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { DEMO_ORG_NAME, DEMO_ROLES } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const newRole = (body: object, token = a.token) => call(roles.POST, { token, body: { name: '角色', baseRole: 'MANAGER', permissions: ['record.read.all'], ...body } });
const patchUser = (id: string, body: object) => call(userItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('custom roles R2', () => {
  it('并发上限；删除与分配并发 / concurrent cap; delete vs assign', async () => {
    const res = await Promise.all(Array.from({ length: 35 }, (_, i) => newRole({ name: `并发${i}` })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(30);
    const role = res.find((r) => r.status === 201)!.json;
    const users = await Promise.all(Array.from({ length: 4 }, (_, i) => addUser(a.org.id, 'MANAGER', `经理${i}`)));
    const [del, ...assigned] = await Promise.all([call(roleItem.DELETE, { token: a.token, params: { id: role.id }, method: 'DELETE' }), ...users.map((u) => patchUser(u.user.id, { customRoleId: role.id }))]);
    const exists = await prisma.customRole.count({ where: { id: role.id } });
    const holders = await prisma.user.count({ where: { customRoleId: role.id } });
    // 不变量：有用户使用时角色一定存在 / invariant: while users hold it the role exists
    if (holders) expect(exists).toBe(1);
    if (del.status === 204) expect(holders).toBe(0);
    else expect(del.json.error.details).toEqual({ role: ['in_use'] });
    expect(assigned.filter((r) => r.status === 200).length).toBe(holders);
  });

  it('数据库约束与跨组织 / constraints and isolation', async () => {
    const org = a.org.id;
    const bad = [
      () => prisma.customRole.create({ data: { organizationId: org, name: '管理员', baseRole: 'ADMIN', permissions: [] } }),
      () => prisma.customRole.create({ data: { organizationId: org, name: '提权', baseRole: 'SALES', permissions: ['user.manage'] } }),
      () => prisma.customRole.create({ data: { organizationId: org, name: '集成', baseRole: 'SALES', permissions: ['integration.manage'] } }),
      () => prisma.customRole.create({ data: { organizationId: org, name: '未知', baseRole: 'SALES', permissions: ['record.fly'] } }),
      () => prisma.customRole.create({ data: { organizationId: org, name: ' ', baseRole: 'SALES', permissions: [] } }),
    ];
    for (const [i, f] of bad.entries()) await expect(f(), `case ${i}`).rejects.toThrow();
    // 导出权限可以授予（修正后的目录）/ data.export is grantable (the corrected catalogue)
    await expect(prisma.customRole.create({ data: { organizationId: org, name: '可导出', baseRole: 'SALES', permissions: ['data.export'] } })).resolves.toBeTruthy();
    const role = (await newRole({ name: '经理受限' })).json;
    await expect(prisma.user.update({ where: { id: a.user.id }, data: { customRoleId: role.id } })).rejects.toThrow();
    const b = await createTenant('B');
    const bUser = await addUser(b.org.id, 'MANAGER', 'B经理');
    await expect(prisma.user.update({ where: { id: bUser.user.id }, data: { customRoleId: role.id } })).rejects.toThrow();
    expect((await call(roleItem.PATCH, { token: b.token, params: { id: role.id }, body: { name: '改' }, method: 'PATCH' })).status).toBe(404);
    expect((await call(roles.GET, { token: b.token })).json.custom).toEqual([]);
    expect((await call(userItem.PATCH, { token: b.token, params: { id: bUser.user.id }, body: { customRoleId: role.id }, method: 'PATCH' })).json.error.details).toEqual({ customRoleId: ['not_found'] });
  });

  it('去掉权限后接口实际拒绝；API 密钥；最后一名管理员 / removed permissions are enforced; API keys; last admin', async () => {
    const limited = (await newRole({ name: '受限经理', permissions: ['record.read.all', 'record.create', 'record.update.all', 'record.update.own'] })).json;
    const mgr = await addUser(a.org.id, 'MANAGER', '经理');
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    // 系统经理可删除、看采购、维护工作流 / a system manager deletes, sees purchases, maintains workflows
    expect((await call(purchaseOrders.GET, { token: mgr.token })).status).toBe(200);
    await patchUser(mgr.user.id, { customRoleId: limited.id });
    expect((await call(accountItem.DELETE, { token: mgr.token, params: { id: acct.id }, method: 'DELETE' })).status).toBe(403);
    expect((await call(purchaseOrders.GET, { token: mgr.token })).status).toBe(403);
    expect((await call(workflows.POST, { token: mgr.token, body: { name: '规则', entity: 'LEAD', trigger: 'CREATE', conditions: [], actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] } })).status).toBe(403);
    expect((await call(accountItem.PATCH, { token: mgr.token, params: { id: acct.id }, body: { name: '经理改名' }, method: 'PATCH' })).status).toBe(200);
    // API 密钥按其用户的自定义角色 / API keys follow their user's custom role
    const keys = await import('@/app/api/api-keys/route');
    const key = (await call(keys.POST, { token: a.token, body: { name: '经理密钥', userId: mgr.user.id } })).json.key;
    expect((await call(purchaseOrders.GET, { token: key })).status).toBe(403);
    expect((await call(me.GET, { token: key })).json.permissions).toEqual(['record.read.all', 'record.create', 'record.update.all', 'record.update.own']);
    // 最后一名管理员仍不能被降级 / the last admin still cannot be demoted
    const admin2 = await addUser(a.org.id, 'ADMIN', '管理员二');
    expect((await call(userItem.PATCH, { token: admin2.token, params: { id: a.user.id }, body: { role: 'MANAGER', customRoleId: limited.id }, method: 'PATCH' })).status).toBe(200);
    expect((await call(userItem.PATCH, { token: a.token, params: { id: admin2.user.id }, body: { role: 'MANAGER' }, method: 'PATCH' })).status).toBe(403);
  });

  it('演示数据 / demo data', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.customRole.findMany({ where: { organizationId: org.id }, include: { _count: { select: { users: true } } } });
    expect(rows.map((r) => r.name)).toEqual(DEMO_ROLES.map((r) => r.name));
    for (const r of rows) {
      expect(r.name).toContain('【演示】');
      expect(r._count.users).toBe(0);
    }
    // 重建前把角色分配给一个账号，重建后账号恢复系统角色、角色重建 / assign before reset; afterwards the user is back on the system role
    const sales = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'SALES' } });
    await prisma.user.update({ where: { id: sales.id }, data: { customRoleId: rows[0]!.id } });
    await seedDemo({ reset: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: sales.id } })).customRoleId).toBeNull();
    expect(await prisma.customRole.count({ where: { organizationId: org.id } })).toBe(DEMO_ROLES.length);
  });
});
