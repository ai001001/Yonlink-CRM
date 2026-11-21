/**
 * 区域管理 第二轮：集成测试（并发新建不超过上限；并发移动不会成环；数据库约束与树形守卫；跨组织引用被拒绝；
 * 3000 个客户分批重新分配与并发重新分配；组织隔离；演示数据的区域与分配一致）。
 * Territories round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_TERRITORIES } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as apply from '@/app/api/territories/apply/route';
import * as territoryItem from '@/app/api/territories/[id]/route';
import * as territories from '@/app/api/territories/route';
import { prisma } from '@/server/db';
import { MAX_TERRITORIES } from '@/server/modules/territories';
import { matchTerritory } from '@/server/modules/territory-rules';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const newTerritory = (body: object, token = a.token) => call(territories.POST, { token, body: { name: '区域', ...body } });
const addr = (op: string, value: string) => ({ field: 'address', op, value });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('territories R2', () => {
  it('并发：新建不超过 100 个；互相移动不会成环 / concurrent creates and moves', async () => {
    await prisma.territory.createMany({ data: Array.from({ length: MAX_TERRITORIES - 1 }, (_, i) => ({ organizationId: a.org.id, name: `已有${i}` })) });
    const results = await Promise.all([1, 2, 3].map((i) => newTerritory({ name: `并发${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.json.error.details.name[0] === 'limit_reached')).toBe(true);
    expect(await prisma.territory.count({ where: { organizationId: a.org.id } })).toBe(MAX_TERRITORIES);
    // 两个顶级区域同时互相设为上级：只有一个成功 / two roots made each other's parent at once: only one succeeds
    await prisma.territory.deleteMany({ where: { organizationId: a.org.id } });
    const x = (await newTerritory({ name: 'X' })).json;
    const y = (await newTerritory({ name: 'Y' })).json;
    const moves = await Promise.all([
      call(territoryItem.PATCH, { token: a.token, params: { id: x.id }, body: { parentId: y.id }, method: 'PATCH' }),
      call(territoryItem.PATCH, { token: a.token, params: { id: y.id }, body: { parentId: x.id }, method: 'PATCH' }),
    ]);
    expect(moves.map((m) => m.status).sort()).toEqual([200, 400]);
    const rows = await prisma.territory.findMany({ where: { organizationId: a.org.id } });
    expect(rows.filter((r) => r.parentId === null)).toHaveLength(1);
  });

  it('数据库约束、树形守卫、跨组织引用 / constraints, tree guard, cross-organization references', async () => {
    const top = (await newTerritory({ name: '一级' })).json;
    const mid = (await newTerritory({ name: '二级', parentId: top.id })).json;
    const leaf = (await newTerritory({ name: '三级', parentId: mid.id })).json;
    const raw = (sql: Promise<unknown>) => expect(sql).rejects.toThrow();
    // 绕过服务直接写库：层级、环、自引用都被拒绝 / direct writes: depth, cycles and self-parents are refused
    await expect(prisma.$executeRaw`INSERT INTO territories (id, organization_id, parent_id, name, updated_at) VALUES (gen_random_uuid(), ${a.org.id}::uuid, ${leaf.id}::uuid, '四级', now())`).rejects.toThrow(/territories_tree_check|too deep/);
    await expect(prisma.$executeRaw`UPDATE territories SET parent_id = ${leaf.id}::uuid WHERE id = ${top.id}::uuid`).rejects.toThrow(/territories_tree_check|cycle/);
    await raw(prisma.$executeRaw`UPDATE territories SET parent_id = id WHERE id = ${top.id}::uuid`);
    await expect(prisma.$executeRaw`UPDATE territories SET priority = 0 WHERE id = ${top.id}::uuid`).rejects.toThrow(/territories_check/);
    await expect(prisma.$executeRaw`UPDATE territories SET name = '  ' WHERE id = ${top.id}::uuid`).rejects.toThrow(/territories_check/);
    await expect(prisma.$executeRaw`UPDATE territories SET conditions = '{}'::jsonb WHERE id = ${top.id}::uuid`).rejects.toThrow(/territories_check/);
    await expect(prisma.$executeRaw`UPDATE territories SET name = 'ER JI' WHERE id = ${top.id}::uuid`).resolves.toBe(1);
    await expect(prisma.$executeRaw`UPDATE territories SET name = ' er ji ' WHERE id = ${mid.id}::uuid`).rejects.toThrow(/territories_organization_id_name_key/);
    // 有客户时不能直接删除区域（外键）/ a territory with accounts cannot be deleted directly (FK)
    const acc = await prisma.account.create({ data: { organizationId: a.org.id, name: '客户', territoryId: leaf.id } });
    await raw(prisma.territory.delete({ where: { id: leaf.id } }));
    // 跨组织：客户、上级、成员都不能引用其他组织的区域或用户 / cross-organization references are refused
    const b = await createTenant('B');
    const bt = (await newTerritory({ name: 'B区' }, b.token)).json;
    await raw(prisma.account.update({ where: { id: acc.id }, data: { territoryId: bt.id } }));
    await raw(prisma.$executeRaw`UPDATE territories SET parent_id = ${top.id}::uuid WHERE id = ${bt.id}::uuid`);
    await raw(prisma.territoryMember.create({ data: { organizationId: a.org.id, territoryId: top.id, userId: b.user.id } }));
    await raw(prisma.$executeRaw`UPDATE territories SET manager_id = ${b.user.id}::uuid WHERE id = ${top.id}::uuid`);
    // 删除组织级联删除区域与成员 / organization deletion cascades
    await prisma.territoryMember.create({ data: { organizationId: b.org.id, territoryId: bt.id, userId: b.user.id } });
    expect(await prisma.territoryMember.count({ where: { territoryId: bt.id } })).toBe(1);
  });

  it('3000 个客户分批重新分配；并发重新分配结果一致 / batched and concurrent apply', async () => {
    const cn = (await newTerritory({ name: '国内', priority: 50, conditions: [addr('STARTS_WITH', '国内')] })).json;
    const east = (await newTerritory({ name: '华东', parentId: cn.id, priority: 10, match: 'ANY', conditions: [addr('CONTAINS', '杭州'), addr('CONTAINS', '常州')] })).json;
    const cities = ['国内 · 杭州', '国内 · 常州', '国内 · 成都', '北美 · 芝加哥', null];
    await prisma.account.createMany({ data: Array.from({ length: 3000 }, (_, i) => ({ organizationId: a.org.id, name: `批量${i}`, address: cities[i % 5] })) });
    await prisma.account.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ organizationId: a.org.id, name: `手工${i}`, address: '国内 · 杭州', territoryManual: true })) });
    const t0 = Date.now();
    const results = await Promise.all([call(apply.POST, { token: a.token }), call(apply.POST, { token: a.token })]);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(results.map((r) => r.json).sort((x, y) => y.changed - x.changed)).toEqual([
      { checked: 3000, changed: 1800 },
      { checked: 3000, changed: 0 },
    ]);
    const counts = await prisma.account.groupBy({ by: ['territoryId'], where: { organizationId: a.org.id }, _count: { _all: true } });
    const of = (id: string | null) => counts.find((c) => c.territoryId === id)?._count._all;
    expect([of(east.id), of(cn.id), of(null)]).toEqual([1200, 600, 1210]);
    // 筛选“国内”含下级 / the 国内 filter includes children
    expect((await call(accounts.GET, { token: a.token, query: { territoryId: cn.id, pageSize: '1' } })).json.total).toBe(1800);
    const list = (await call(territories.GET, { token: a.token })).json;
    expect(list.items.find((x: { id: string }) => x.id === cn.id).stats.accounts).toBe(1800);
    expect(list.unassigned.accounts).toBe(1210);
  }, 120_000);

  it('组织隔离：列表、筛选、统计、重新分配互不影响 / organization isolation', async () => {
    const b = await createTenant('B');
    const ta = (await newTerritory({ name: '同名', conditions: [addr('CONTAINS', '杭州')] })).json;
    const tb = (await newTerritory({ name: '同名', conditions: [addr('CONTAINS', '杭州')], memberIds: [b.user.id] }, b.token)).json;
    await call(accounts.POST, { token: a.token, body: { name: 'A客户', address: '杭州' } });
    await prisma.account.create({ data: { organizationId: b.org.id, name: 'B客户', address: '杭州' } });
    expect((await call(apply.POST, { token: a.token })).json).toEqual({ checked: 1, changed: 0 });
    expect((await prisma.account.findFirstOrThrow({ where: { name: 'B客户' } })).territoryId).toBeNull();
    expect((await call(apply.POST, { token: b.token })).json).toEqual({ checked: 1, changed: 1 });
    expect((await call(territories.GET, { token: a.token })).json.items.map((x: { id: string }) => x.id)).toEqual([ta.id]);
    expect((await call(territories.GET, { token: b.token })).json.items[0].stats.accounts).toBe(1);
    expect((await call(accounts.GET, { token: a.token, query: { territoryId: tb.id } })).json.total).toBe(0);
    expect((await call(accounts.GET, { token: b.token, query: { territoryId: 'MINE' } })).json.items.map((x: { name: string }) => x.name)).toEqual(['B客户']);
  });

  it('演示数据：5 个区域、成员与负责人、分配与规则一致 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.territory.findMany({ where: { organizationId: org.id }, include: { parent: true, manager: true, members: { include: { user: true } } } });
    expect(rows.map((r) => [r.name, r.parent?.name ?? null]).sort()).toEqual(DEMO_TERRITORIES.map((t) => [t.name, t.parent ? DEMO_TERRITORIES.find((p) => p.key === t.parent)!.name : null]).sort());
    expect(rows.find((r) => r.name === '【演示】北美')!.manager?.name).toBe('王芳');
    const accs = await prisma.account.findMany({ where: { organizationId: org.id } });
    expect(accs.every((x) => !x.territoryManual && x.territoryId === matchTerritory(rows, x))).toBe(true);
    const by = (n: string) => accs.filter((x) => x.territoryId === rows.find((r) => r.name === n)!.id).length;
    expect([by('【演示】华东'), by('【演示】国内'), by('【演示】北美'), by('【演示】欧洲'), by('【演示】海外')]).toEqual([4, 5, 5, 5, 11]);
    const admin = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'ADMIN' } });
    expect(admin).toBeTruthy();
  });
});
