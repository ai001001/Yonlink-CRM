/**
 * 宏 第二轮：集成测试（并发新建不超过上限；同一宏并发执行：标签不重复、执行次数准确；100 条记录的执行耗时；
 * 数据库约束；组织隔离；创建人停用后共享宏仍可用；演示宏可见范围与执行）。
 * Macros round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_MACROS, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as leads from '@/app/api/leads/route';
import * as macroRun from '@/app/api/macros/[id]/run/route';
import * as macros from '@/app/api/macros/route';
import * as tags from '@/app/api/tags/route';
import { prisma } from '@/server/db';
import { MAX_MACROS, MAX_PERSONAL_MACROS } from '@/server/modules/macros';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { hashToken } from '@/server/auth';
import { randomBytes } from 'node:crypto';

let a: Awaited<ReturnType<typeof createTenant>>;
const newMacro = (body: object, token = a.token) => call(macros.POST, { token, body: { name: '宏', entity: 'LEAD', actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'CONTACTED' }], ...body } });
const run = (id: string, ids: string[], token = a.token) => call(macroRun.POST, { token, params: { id }, body: { ids } });
const action = [{ type: 'UPDATE_FIELD', field: 'status', value: 'NEW' }];

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('macros R2', () => {
  it('并发新建：组织上限与个人上限都不会超过 / concurrent creates respect both limits', async () => {
    const s = await addUser(a.org.id, 'SALES', '销售');
    await prisma.macro.createMany({ data: Array.from({ length: MAX_PERSONAL_MACROS - 1 }, (_, i) => ({ organizationId: a.org.id, name: `个人${i}`, entity: 'LEAD', scope: 'PERSONAL', createdById: s.user.id, actions: action })) });
    const personal = await Promise.all([1, 2, 3].map((i) => newMacro({ name: `并发个人${i}` }, s.token)));
    expect(personal.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.macro.count({ where: { createdById: s.user.id } })).toBe(MAX_PERSONAL_MACROS);
    await prisma.macro.createMany({ data: Array.from({ length: MAX_MACROS - MAX_PERSONAL_MACROS - 1 }, (_, i) => ({ organizationId: a.org.id, name: `共享${i}`, entity: 'DEAL', scope: 'SHARED', createdById: a.user.id, actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'PROPOSAL' }] })) });
    const shared = await Promise.all([1, 2, 3].map((i) => newMacro({ name: `并发共享${i}`, scope: 'SHARED' })));
    expect(shared.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.macro.count({ where: { organizationId: a.org.id } })).toBe(MAX_MACROS);
  });

  it('同一宏并发执行与 100 条记录耗时 / concurrent runs and 100 records', async () => {
    const tag = (await call(tags.POST, { token: a.token, body: { name: '标记' } })).json;
    const m = (await newMacro({ name: '标记并建任务', actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'CONTACTED' }, { type: 'ADD_TAG', tagId: tag.id }, { type: 'CREATE_TASK', subject: '跟进', dueInDays: 1, assignTo: 'OWNER' }] })).json;
    await prisma.lead.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ organizationId: a.org.id, ownerId: a.user.id, name: `批量${i}` })) });
    const ids = (await prisma.lead.findMany({ select: { id: true } })).map((l) => l.id);
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([run(m.id, ids.slice(0, 50)), run(m.id, ids.slice(0, 50))]);
    const r3 = await run(m.id, ids);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect([r1.json.failed, r2.json.failed, r3.json.failed]).toEqual([[], [], []]);
    expect(r3.json.succeeded).toHaveLength(100);
    expect(await prisma.leadTag.count({ where: { tagId: tag.id } })).toBe(100); // 标签不重复 / no duplicate tags
    expect(await prisma.activity.count({ where: { subject: '跟进' } })).toBe(200); // 每次执行各建一个任务 / one task per run
    expect(await prisma.lead.count({ where: { status: 'CONTACTED' } })).toBe(100);
    expect((await prisma.macro.findUniqueOrThrow({ where: { id: m.id } })).runCount).toBe(3);
  }, 120_000);

  it('数据库约束与组织隔离；创建人停用后共享宏仍可用 / constraints, isolation, inactive creator', async () => {
    const m = (await newMacro({ name: 'A 宏', scope: 'SHARED' })).json;
    await expect(prisma.$executeRaw`UPDATE macros SET name = ' ' WHERE id = ${m.id}::uuid`).rejects.toThrow(/macros_check/);
    await expect(prisma.$executeRaw`UPDATE macros SET actions = '[]'::jsonb WHERE id = ${m.id}::uuid`).rejects.toThrow(/macros_check/);
    await expect(prisma.$executeRaw`UPDATE macros SET actions = '{}'::jsonb WHERE id = ${m.id}::uuid`).rejects.toThrow(/macros_check/);
    await expect(prisma.$executeRaw`UPDATE macros SET actions = (SELECT jsonb_agg(x) FROM generate_series(1, 6) x) WHERE id = ${m.id}::uuid`).rejects.toThrow(/macros_check/);
    await expect(prisma.$executeRaw`UPDATE macros SET run_count = -1 WHERE id = ${m.id}::uuid`).rejects.toThrow(/macros_check/);
    await expect(prisma.macro.create({ data: { organizationId: a.org.id, name: ' a 宏', entity: 'LEAD', scope: 'PERSONAL', createdById: a.user.id, actions: action } })).rejects.toThrow();
    const b = await createTenant('B');
    await expect(prisma.macro.create({ data: { organizationId: a.org.id, name: '跨组织', entity: 'LEAD', scope: 'PERSONAL', createdById: b.user.id, actions: action } })).rejects.toThrow();
    // 隔离：B 看不到、不能执行 A 的宏；A 的宏碰不到 B 的记录 / isolation
    expect((await call(macros.GET, { token: b.token })).json.items).toEqual([]);
    const bl = (await call(leads.POST, { token: b.token, body: { name: 'B 线索' } })).json;
    expect((await run(m.id, [bl.id], b.token)).status).toBe(404);
    expect((await run(m.id, [bl.id])).json.failed).toEqual([{ id: bl.id, code: 'NOT_FOUND', message: expect.any(String) }]);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: bl.id } })).status).toBe('NEW');
    // 创建人停用后，其他人仍可执行共享宏 / shared macros keep working after the creator is deactivated
    const mgr = await addUser(a.org.id, 'MANAGER', '经理');
    await prisma.user.update({ where: { id: a.user.id }, data: { isActive: false } });
    const al = await prisma.lead.create({ data: { organizationId: a.org.id, ownerId: mgr.user.id, name: 'A 线索' } });
    expect((await run(m.id, [al.id], mgr.token)).json.succeeded).toEqual([al.id]);
  });

  it('演示宏：可见范围与执行 / demo macros', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    expect((await prisma.macro.findMany({ where: { organizationId: org.id } })).map((m) => m.name).sort()).toEqual(DEMO_MACROS.map((m) => m.name).sort());
    // 以演示用户会话调用接口 / call the API as demo users
    const session = async (email: string) => {
      const u = await prisma.user.findUniqueOrThrow({ where: { email } });
      const token = randomBytes(32).toString('base64url');
      await prisma.session.create({ data: { userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
      return { token, id: u.id };
    };
    const wang = await session('sales1@demo.yonlink.test');
    const chen = await session('sales2@demo.yonlink.test');
    const names = async (token: string) => ((await call(macros.GET, { token })).json.items as { name: string }[]).map((m) => m.name).sort();
    expect(await names(wang.token)).toEqual(['【演示】已联系并安排回访', '【演示】展会线索整理', '【演示】进入方案报价'].sort());
    expect(await names(chen.token)).toEqual(['【演示】已联系并安排回访', '【演示】进入方案报价'].sort());
    const macro = (await call(macros.GET, { token: wang.token, query: { entity: 'LEAD' } })).json.items.find((m: { name: string }) => m.name === '【演示】展会线索整理');
    const lead = await prisma.lead.findFirstOrThrow({ where: { organizationId: org.id, ownerId: wang.id, status: { not: 'CONVERTED' } } });
    expect((await run(macro.id, [lead.id], wang.token)).json).toEqual({ succeeded: [lead.id], failed: [] });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { tags: { include: { tag: true } } } });
    expect(after.source).toBe('EXHIBITION');
    expect(after.tags.map((x) => x.tag.name)).toContain('展会线索');
  });
});
