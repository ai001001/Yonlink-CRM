/**
 * 销售节奏 第二轮：集成测试（3 个进程并发处理：每个参与只处理一次；同一记录并发加入只成功一个；1200 个参与分批处理；
 * 数据库约束；删除记录时参与级联删除；组织隔离；定时任务脚本实际运行；演示节奏与参与）。
 * Cadences round 2: integration tests.
 */
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_CADENCES, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as cadenceEnroll from '@/app/api/cadences/[id]/enroll/route';
import * as cadences from '@/app/api/cadences/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import { prisma } from '@/server/db';
import { sweepCadences } from '@/server/modules/cadences';
import { call, createTenant, resetDb } from '../helpers';

const DAY = 86_400_000;
let a: Awaited<ReturnType<typeof createTenant>>;
const STEPS = [
  { day: 0, type: 'CALL', subject: '电话' },
  { day: 2, type: 'TASK', subject: '任务' },
];
const newCadence = async (body: object = {}, token = a.token) => (await call(cadences.POST, { token, body: { name: '节奏', entity: 'LEAD', steps: STEPS, ...body } })).json;
/** 直接写入 n 条 3 天前加入的参与 / insert n enrollments made 3 days ago */
async function bulkEnroll(org: string, owner: string, cadenceId: string, n: number) {
  await prisma.lead.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: org, ownerId: owner, name: `批量${i}` })) });
  const ids = (await prisma.lead.findMany({ where: { organizationId: org, name: { startsWith: '批量' } }, select: { id: true } })).map((l) => l.id);
  const enrolledAt = new Date(Date.now() - 3 * DAY);
  await prisma.cadenceEnrollment.createMany({ data: ids.map((leadId) => ({ organizationId: org, cadenceId, leadId, enrolledById: owner, enrolledAt, nextDueAt: enrolledAt })) });
  return ids;
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('cadences R2', () => {
  it('3 个进程并发处理：每个参与只处理一次；同一记录并发加入只成功一个 / concurrent sweeps and enrolls', async () => {
    const c = await newCadence();
    await bulkEnroll(a.org.id, a.user.id, c.id, 300);
    const results = await Promise.all([sweepCadences(), sweepCadences(), sweepCadences()]);
    expect(results.reduce((s, r) => s + r.processed, 0)).toBe(300);
    expect(results.reduce((s, r) => s + r.activities, 0)).toBe(600);
    expect(await prisma.activity.count()).toBe(600);
    expect(await prisma.cadenceEnrollment.count({ where: { status: 'COMPLETED' } })).toBe(300);
    // 并发加入同一记录 / concurrent enrolls of the same record
    const l = (await call(leads.POST, { token: a.token, body: { name: '并发' } })).json;
    const res = await Promise.all([1, 2, 3].map(() => call(cadenceEnroll.POST, { token: a.token, params: { id: c.id }, body: { ids: [l.id] } })));
    expect(res.map((r) => r.json.succeeded.length).sort()).toEqual([0, 0, 1]);
    expect(res.flatMap((r) => r.json.failed.map((f: { code: string }) => f.code))).toEqual(['CONFLICT', 'CONFLICT']);
    expect(await prisma.cadenceEnrollment.count({ where: { leadId: l.id } })).toBe(1);
    expect(await prisma.activity.count({ where: { leadId: l.id } })).toBe(1);
  });

  it('1200 个参与分批处理；定时任务脚本实际运行 / batches and the script', async () => {
    const c = await newCadence({ steps: [{ day: 0, type: 'CALL', subject: '电话' }, { day: 5, type: 'TASK', subject: '任务' }] });
    await bulkEnroll(a.org.id, a.user.id, c.id, 1200);
    const t0 = Date.now();
    const r = await sweepCadences();
    expect(Date.now() - t0).toBeLessThan(90_000);
    expect(r).toMatchObject({ processed: 1200, activities: 1200, failures: [] });
    expect(await prisma.cadenceEnrollment.count({ where: { status: 'ACTIVE', currentStep: 1 } })).toBe(1200);
    // 脚本：第 5 天的步骤尚未到期，没有可处理的参与 / the script: day-5 steps are not due yet
    const out = execFileSync('npx', ['tsx', 'scripts/workflow-sweep.ts'], { env: process.env, encoding: 'utf8' });
    expect(out).toMatch(/销售节奏完成 \/ cadences done: 节奏 1 个，退出 0 个参与，处理 0 个参与，创建跟进 0 条，出错 0 个/);
    await prisma.cadenceEnrollment.updateMany({ data: { nextDueAt: new Date(Date.now() - 60_000) } });
    const out2 = execFileSync('npx', ['tsx', 'scripts/workflow-sweep.ts'], { env: process.env, encoding: 'utf8' });
    expect(out2).toMatch(/处理 1200 个参与，创建跟进 0 条/); // 到期时间已提前，但第 5 天尚未到，只重算 / day 5 is still ahead: only rescheduled
  }, 180_000);

  it('数据库约束；删除记录时参与级联删除；组织隔离 / constraints, cascade, isolation', async () => {
    const c = await newCadence();
    const l = (await call(leads.POST, { token: a.token, body: { name: '线索' } })).json;
    await call(cadenceEnroll.POST, { token: a.token, params: { id: c.id }, body: { ids: [l.id] } });
    const e = await prisma.cadenceEnrollment.findFirstOrThrow();
    await expect(prisma.$executeRaw`UPDATE cadence_enrollments SET lead_id = NULL WHERE id = ${e.id}::uuid`).rejects.toThrow(/cadence_enrollments_check/);
    await expect(prisma.$executeRaw`UPDATE cadence_enrollments SET next_due_at = NULL WHERE id = ${e.id}::uuid`).rejects.toThrow(/cadence_enrollments_check/);
    await expect(prisma.$executeRaw`UPDATE cadence_enrollments SET status = 'COMPLETED' WHERE id = ${e.id}::uuid`).rejects.toThrow(/cadence_enrollments_check/);
    await expect(prisma.$executeRaw`UPDATE cadence_enrollments SET current_step = -1 WHERE id = ${e.id}::uuid`).rejects.toThrow(/cadence_enrollments_check/);
    await expect(prisma.cadenceEnrollment.create({ data: { organizationId: a.org.id, cadenceId: c.id, leadId: l.id, enrolledById: a.user.id, nextDueAt: new Date() } })).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE cadences SET steps = '[]'::jsonb WHERE id = ${c.id}::uuid`).rejects.toThrow(/cadences_check/);
    await expect(prisma.$executeRaw`UPDATE cadences SET exit_states = '{}'::jsonb WHERE id = ${c.id}::uuid`).rejects.toThrow(/cadences_check/);
    await expect(prisma.$executeRaw`UPDATE cadences SET name = ' ' WHERE id = ${c.id}::uuid`).rejects.toThrow(/cadences_check/);
    // 跨组织：B 的节奏不能用于 A 的记录 / cross-organization references
    const b = await createTenant('B');
    const bc = await newCadence({}, b.token);
    await expect(prisma.cadenceEnrollment.create({ data: { organizationId: a.org.id, cadenceId: bc.id, leadId: l.id, enrolledById: a.user.id, nextDueAt: new Date() } })).rejects.toThrow();
    await expect(prisma.cadenceEnrollment.create({ data: { organizationId: b.org.id, cadenceId: bc.id, leadId: l.id, enrolledById: b.user.id, nextDueAt: new Date() } })).rejects.toThrow();
    // 按组织处理：B 的到期参与不受 A 的处理影响 / per-organization sweeps
    const bl = await prisma.lead.create({ data: { organizationId: b.org.id, ownerId: b.user.id, name: 'B 线索' } });
    await prisma.cadenceEnrollment.create({ data: { organizationId: b.org.id, cadenceId: bc.id, leadId: bl.id, enrolledById: b.user.id, enrolledAt: new Date(Date.now() - DAY), nextDueAt: new Date(Date.now() - DAY) } });
    expect((await sweepCadences({ organizationId: a.org.id, now: new Date(Date.now() + 3 * DAY) })).processed).toBe(1);
    expect(await prisma.activity.count({ where: { organizationId: b.org.id } })).toBe(0);
    // 删除线索（进回收站）时参与级联删除 / deleting the lead cascades its enrollments
    expect((await call(leadItem.DELETE, { token: a.token, params: { id: l.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.cadenceEnrollment.count({ where: { organizationId: a.org.id } })).toBe(0);
  });

  it('演示节奏：2 个节奏，3 条线索与 2 个商机 3 天前加入，已补建到期步骤 / demo cadences', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.cadence.findMany({ where: { organizationId: org.id }, include: { enrollments: true } });
    expect(rows.map((c) => c.name).sort()).toEqual(DEMO_CADENCES.map((c) => c.name).sort());
    const lead7 = rows.find((c) => c.entity === 'LEAD')!;
    const proposal = rows.find((c) => c.entity === 'DEAL')!;
    expect(lead7.enrollments.map((e) => [e.status, e.currentStep])).toEqual([['ACTIVE', 2], ['ACTIVE', 2], ['ACTIVE', 2]]);
    expect(proposal.enrollments.map((e) => [e.status, e.currentStep])).toEqual([['ACTIVE', 2], ['ACTIVE', 2]]);
    const leadIds = lead7.enrollments.map((e) => e.leadId!);
    expect(await prisma.activity.count({ where: { leadId: { in: leadIds }, subject: { in: ['【演示】首次电话联系，了解车型与用量', '【演示】发送产品目录与报价区间'] } } })).toBe(6);
    const leadsOk = await prisma.lead.findMany({ where: { id: { in: leadIds } } });
    expect(leadsOk.every((l) => l.status === 'NEW')).toBe(true);
  });
});
