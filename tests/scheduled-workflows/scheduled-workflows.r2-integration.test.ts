/**
 * 定时工作流 第二轮：集成测试（3 个进程并发运行：每条记录只执行一次；按组织运行与组织隔离；损坏的规则不影响其他规则；
 * 删除规则时执行记录级联删除；数据库约束；每条规则每次最多 500 条、余下下次继续；脚本实际运行输出；演示规则可执行）。
 * Scheduled workflows round 2: integration tests.
 */
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { sweepScheduledWorkflows } from '@/server/modules/workflow-schedule';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const inactivityRule = async (t = a, extra: object = {}) =>
  (await call(workflows.POST, { token: t.token, body: { name: `无跟进${Math.random()}`, entity: 'LEAD', trigger: 'INACTIVITY', triggerDays: 7, actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '提醒' }], ...extra } })).json as { id: string };
/** 直接写入 n 条 10 天前创建的线索 / insert n leads created 10 days ago */
async function staleLeads(org: string, owner: string, n: number) {
  await prisma.lead.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: org, ownerId: owner, name: `沉默${i}`, createdAt: new Date(Date.now() - 10 * 86_400_000) })) });
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('scheduled workflows R2', () => {
  it('3 个进程并发：每条只执行一次 / concurrent runs execute each record once', async () => {
    await inactivityRule();
    await staleLeads(a.org.id, a.user.id, 30);
    const results = await Promise.all([sweepScheduledWorkflows(), sweepScheduledWorkflows(), sweepScheduledWorkflows()]);
    expect(results.reduce((s, r) => s + r.ran, 0)).toBe(30);
    expect(await prisma.notification.count({ where: { type: 'WORKFLOW' } })).toBe(30);
    expect(await prisma.workflowScheduleRun.count()).toBe(30);
  });

  it('按组织运行与隔离；损坏规则不影响其他；删除规则级联；数据库约束 / isolation, corrupted rules, cascade, constraints', async () => {
    const b = await createTenant('B');
    const ra = await inactivityRule();
    const rb = await inactivityRule(b);
    await staleLeads(a.org.id, a.user.id, 2);
    await staleLeads(b.org.id, b.user.id, 3);
    expect((await sweepScheduledWorkflows({ organizationId: a.org.id })).ran).toBe(2);
    expect(await prisma.notification.count({ where: { organizationId: b.org.id } })).toBe(0);
    // 损坏的规则：跳过但登记执行键，其他规则照常 / a corrupted rule is skipped while others run
    await prisma.workflowRule.update({ where: { id: rb.id }, data: { actions: [{ type: 'SEND_FAX' }] } });
    const c = await inactivityRule(b);
    const r = await sweepScheduledWorkflows();
    expect(r.failures).toEqual([]);
    expect(await prisma.notification.count({ where: { organizationId: b.org.id } })).toBe(3);
    expect(await prisma.workflowScheduleRun.count({ where: { ruleId: c.id } })).toBe(3);
    // 删除规则：执行记录级联 / deleting a rule cascades its runs
    await prisma.workflowRule.delete({ where: { id: ra.id } });
    expect(await prisma.workflowScheduleRun.count({ where: { ruleId: ra.id } })).toBe(0);
    // 约束 / constraints
    await expect(prisma.$executeRaw`UPDATE workflow_rules SET trigger_days = NULL WHERE id = ${c.id}::uuid`).rejects.toThrow(/workflow_rules_check/);
    await expect(prisma.$executeRaw`UPDATE workflow_rules SET trigger_days = 0 WHERE id = ${c.id}::uuid`).rejects.toThrow(/workflow_rules_check/);
    await expect(prisma.$executeRaw`UPDATE workflow_rules SET trigger = 'CREATE' WHERE id = ${c.id}::uuid`).rejects.toThrow(/workflow_rules_check/);
    await expect(prisma.$executeRaw`UPDATE workflow_rules SET trigger = 'DATE_RELATIVE' WHERE id = ${c.id}::uuid`).rejects.toThrow(/workflow_rules_check/);
    await expect(prisma.$executeRaw`UPDATE workflow_schedule_runs SET key = ' '`).rejects.toThrow(/workflow_schedule_runs_check/);
  });

  it('每次最多 500 条，余下下次继续；脚本实际运行 / batches and the script', async () => {
    await inactivityRule();
    await staleLeads(a.org.id, a.user.id, 620);
    const t0 = Date.now();
    expect((await sweepScheduledWorkflows()).ran).toBe(500);
    expect(Date.now() - t0).toBeLessThan(30_000);
    const out = execFileSync('npx', ['tsx', 'scripts/workflow-sweep.ts'], { env: process.env, encoding: 'utf8' });
    expect(out).toMatch(/定时工作流完成 \/ scheduled workflows done: 规则 1 条，检查 120 条记录，执行 120 次，出错 0 条/);
    expect(await prisma.notification.count({ where: { type: 'WORKFLOW' } })).toBe(620);
  }, 120_000);

  it('演示规则：可执行且只提醒高分线索与进行中的商机 / demo rules', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const scheduled = await prisma.workflowRule.findMany({ where: { organizationId: org.id, trigger: { in: ['DATE_RELATIVE', 'INACTIVITY'] } } });
    expect(scheduled.map((r) => [r.trigger, r.triggerField, r.triggerDays]).sort()).toEqual([
      ['DATE_RELATIVE', 'expectedCloseDate', -3],
      ['INACTIVITY', null, 7],
    ]);
    // 让一个进行中的演示商机 3 天后到预计成交日 / make an open demo deal due in 3 days
    const deal = await prisma.deal.findFirstOrThrow({ where: { organizationId: org.id, stage: 'PROPOSAL' } });
    await prisma.deal.update({ where: { id: deal.id }, data: { expectedCloseDate: new Date(`${new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`) } });
    const r = await sweepScheduledWorkflows({ organizationId: org.id });
    expect(r.failures).toEqual([]);
    expect(await prisma.notification.count({ where: { dealId: deal.id, type: 'WORKFLOW' } })).toBe(1);
    const leadNotes = await prisma.notification.findMany({ where: { organizationId: org.id, type: 'WORKFLOW', leadId: { not: null } }, include: { lead: { select: { score: true, status: true } } } });
    expect(leadNotes.every((n) => n.lead!.score >= 50 && n.lead!.status !== 'CONVERTED')).toBe(true);
  });
});
