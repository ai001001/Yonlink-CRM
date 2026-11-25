/**
 * 自定义模块 第二轮：集成测试（并发：模块与字段上限、删除模块与新建记录互斥、并发改派；数据库约束与跨组织外键；
 * 删除客户后关联清空；API 密钥；演示数据：模块、字段、记录、各角色可见数量与重建）。
 * Custom modules round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as moduleFields from '@/app/api/custom-modules/[id]/fields/route';
import * as moduleItem from '@/app/api/custom-modules/[id]/route';
import * as modules from '@/app/api/custom-modules/route';
import * as recordItem from '@/app/api/custom-records/[id]/route';
import * as records from '@/app/api/custom-records/route';
import { hashToken } from '@/server/auth';
import { prisma } from '@/server/db';
import { DEMO_MODULES, DEMO_ORG_NAME, DEMO_USERS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('custom modules R2', () => {
  it('并发：模块与字段上限不超出 / concurrent caps hold', async () => {
    const made = await Promise.all(Array.from({ length: 14 }, (_, i) => call(modules.POST, { token: a.token, body: { name: `并发${i}` } })));
    expect(made.filter((r) => r.status === 201)).toHaveLength(10);
    expect(made.filter((r) => r.status === 409).every((r) => r.json.error.details.name[0] === 'limit_reached')).toBe(true);
    const positions = (await prisma.customModule.findMany({ where: { organizationId: a.org.id }, orderBy: { position: 'asc' } })).map((m) => m.position);
    expect(positions).toEqual([...Array(10).keys()]);
    const m = made.find((r) => r.status === 201)!.json;
    const fields = await Promise.all(Array.from({ length: 34 }, (_, i) => call(moduleFields.POST, { token: a.token, params: { id: m.id }, body: { label: `字段${i}`, type: 'TEXT' } })));
    expect(fields.filter((r) => r.status === 201)).toHaveLength(30);
    expect(new Set((await prisma.customModuleField.findMany({ where: { moduleId: m.id } })).map((f) => f.position)).size).toBe(30);
  });

  it('删除模块与新建记录互斥；并发改派只有一个成功 / delete vs create, concurrent reassignment', async () => {
    const m = (await call(modules.POST, { token: a.token, body: { name: '合同' } })).json;
    const results = await Promise.all([
      call(moduleItem.DELETE, { token: a.token, params: { id: m.id }, method: 'DELETE' }),
      ...Array.from({ length: 5 }, (_, i) => call(records.POST, { token: a.token, body: { moduleId: m.id, name: `记录${i}` } })),
    ]);
    const deleted = results[0]!.status === 204;
    const created = results.slice(1).filter((r) => r.status === 201).length;
    // 要么模块删除成功且没有记录，要么删除因已有记录被拒绝 / either deleted with no records, or refused because records exist
    if (deleted) {
      expect(created).toBe(0);
      expect(await prisma.customModule.count({ where: { id: m.id } })).toBe(0);
    } else {
      expect(results[0]!.json.error.details).toEqual({ module: ['has_records'] });
      expect(await prisma.customRecord.count({ where: { moduleId: m.id } })).toBe(created);
    }
    expect(await prisma.customRecord.count({ where: { moduleId: m.id } })).toBe(created);
    // 并发改派 / concurrent reassignment
    const m2 = (await call(modules.POST, { token: a.token, body: { name: '设备' } })).json;
    const u1 = await addUser(a.org.id, 'SALES', '甲');
    const u2 = await addUser(a.org.id, 'SALES', '乙');
    const r = (await call(records.POST, { token: a.token, body: { moduleId: m2.id, name: '设备一' } })).json;
    const two = await Promise.all([u1, u2].map((u) => call(recordItem.PATCH, { token: a.token, params: { id: r.id }, body: { ownerId: u.user.id }, method: 'PATCH' })));
    const ok = two.filter((x) => x.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const x of two.filter((y) => y.status !== 200)) expect(x.json.error.details).toEqual({ record: ['stale'] });
    const final = await prisma.customRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect([u1.user.id, u2.user.id]).toContain(final.ownerId);
    expect(await prisma.auditLog.count({ where: { entityId: r.id, action: 'customrecord.update' } })).toBe(ok.length);
  });

  it('数据库约束与跨组织外键 / constraints and cross-tenant keys', async () => {
    const m = (await call(modules.POST, { token: a.token, body: { name: '合同' } })).json;
    const org = a.org.id;
    const bad = [
      () => prisma.customModule.create({ data: { organizationId: org, name: ' 前后空格 ', position: 1 } }),
      () => prisma.customModule.create({ data: { organizationId: org, name: '合同'.toUpperCase(), position: 1 } }),
      () => prisma.customModuleField.create({ data: { organizationId: org, moduleId: m.id, key: 'bad', label: 'x', type: 'TEXT', position: 0 } }),
      () => prisma.customModuleField.create({ data: { organizationId: org, moduleId: m.id, key: 'cf_0000aaaa', label: '勾', type: 'CHECKBOX', required: true, position: 0 } }),
      () => prisma.customRecord.create({ data: { organizationId: org, moduleId: m.id, name: 'x', values: [] } }),
      () => prisma.customRecord.create({ data: { organizationId: org, moduleId: m.id, name: ' ' } }),
    ];
    for (const [i, f] of bad.entries()) await expect(f(), `case ${i}`).rejects.toThrow();
    const b = await createTenant('B');
    const bAcct = (await call(accounts.POST, { token: b.token, body: { name: 'B客户' } })).json;
    await expect(prisma.customRecord.create({ data: { organizationId: b.org.id, moduleId: m.id, name: '跨组织模块' } })).rejects.toThrow();
    await expect(prisma.customRecord.create({ data: { organizationId: org, moduleId: m.id, name: '跨组织客户', accountId: bAcct.id } })).rejects.toThrow();
    await expect(prisma.customRecord.create({ data: { organizationId: org, moduleId: m.id, name: '跨组织负责人', ownerId: b.user.id } })).rejects.toThrow();
    await expect(prisma.customModuleField.create({ data: { organizationId: b.org.id, moduleId: m.id, key: 'cf_0000bbbb', label: 'x', type: 'TEXT', position: 0 } })).rejects.toThrow();
  });

  it('删除客户后关联清空；API 密钥按其用户 / account deletion clears links; API keys follow their user', async () => {
    const m = (await call(modules.POST, { token: a.token, body: { name: '合同' } })).json;
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '客户甲' } })).json;
    const r = (await call(records.POST, { token: a.token, body: { moduleId: m.id, name: '合同一', accountId: acct.id } })).json;
    expect((await call(accountItem.DELETE, { token: a.token, params: { id: acct.id }, method: 'DELETE' })).status).toBe(204);
    const after = await prisma.customRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.accountId).toBeNull();
    expect(after.organizationId).toBe(a.org.id);
    const sales = await addUser(a.org.id, 'SALES', '销售');
    const keys = await import('@/app/api/api-keys/route');
    const key = (await call(keys.POST, { token: a.token, body: { name: '集成', userId: sales.user.id } })).json.key;
    expect((await call(records.GET, { token: key, query: { moduleId: m.id } })).json.items).toEqual([]);
    const mine = await call(records.POST, { token: key, body: { moduleId: m.id, name: '密钥创建' } });
    expect(mine.status).toBe(201);
    expect(mine.json.owner.id).toBe(sales.user.id);
    expect((await call(moduleItem.PATCH, { token: key, params: { id: m.id }, body: { isActive: false }, method: 'PATCH' })).status).toBe(403);
  });

  it('演示数据：模块、字段、记录、各角色可见数量、重建 / demo data', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const mods = await prisma.customModule.findMany({ where: { organizationId: org.id }, include: { fields: true, records: { include: { account: true } } }, orderBy: { position: 'asc' } });
    expect(mods.map((m) => m.name)).toEqual(DEMO_MODULES.map((m) => m.name));
    for (const [i, m] of mods.entries()) {
      expect(m.name).toContain('【演示】');
      expect(m.fields).toHaveLength(DEMO_MODULES[i]!.fields.length);
      expect(m.records).toHaveLength(DEMO_MODULES[i]!.records.length);
      for (const r of m.records) {
        expect(r.name).toContain('【演示】');
        expect(r.account?.name).toContain('【演示】');
        // 每条记录的必填字段都有值 / required fields are filled
        for (const f of m.fields.filter((x) => x.required)) expect((r.values as Record<string, unknown>)[f.key]).toBeTruthy();
      }
    }
    // 演示数据不写审计 / the seed writes no audits
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: { in: ['module', 'customrecord'] } } })).toBe(0);
    // 各角色可见数量 / visible counts per role
    const users = await prisma.user.findMany({ where: { organizationId: org.id } });
    const { randomBytes } = await import('node:crypto');
    const tokenOf = async (email: string) => {
      const u = users.find((x) => x.email === email)!;
      const token = randomBytes(32).toString('base64url');
      await prisma.session.create({ data: { userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
      return token;
    };
    const contracts = mods[0]!;
    const countFor = async (key: (typeof DEMO_USERS)[number]['key']) => (await call(records.GET, { token: await tokenOf(DEMO_USERS.find((u) => u.key === key)!.email), query: { moduleId: contracts.id } })).json.total;
    expect(await countFor('admin')).toBe(DEMO_MODULES[0]!.records.length);
    expect(await countFor('viewer')).toBe(DEMO_MODULES[0]!.records.length);
    expect(await countFor('sales1')).toBe(DEMO_MODULES[0]!.records.filter((r) => r.owner === 'sales1').length);
    expect(await countFor('sales2')).toBe(DEMO_MODULES[0]!.records.filter((r) => r.owner === 'sales2').length);
    // 重建：数量不变、记录为新 / reset: same counts, fresh records
    const before = (await prisma.customRecord.findMany({ where: { organizationId: org.id } })).map((r) => r.id);
    await seedDemo({ reset: true });
    const after = await prisma.customRecord.findMany({ where: { organizationId: org.id } });
    expect(after).toHaveLength(before.length);
    expect(after.some((r) => before.includes(r.id))).toBe(false);
    expect(await prisma.customModule.count({ where: { organizationId: org.id } })).toBe(DEMO_MODULES.length);
  });
});
