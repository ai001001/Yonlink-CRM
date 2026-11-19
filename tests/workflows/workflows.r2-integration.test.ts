/**
 * 工作流规则 第二轮：集成测试（并发新建时执行次数准确；接近上限时并发新建不超限；组织隔离（他组织规则不执行、被篡改的他组织用户
 * 被跳过）；数据库约束；损坏的规则数据被安全跳过；通知中心显示工作流提醒；审计日志按对象筛选；演示规则可执行；100 条规则时的写入耗时）。
 * Workflow rules round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_WORKFLOWS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as leads from '@/app/api/leads/route';
import * as notifications from '@/app/api/notifications/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { updateDeal } from '@/server/modules/deals';
import { workflowCreateSchema } from '@/server/modules/workflows';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;

const rule = (name: string, extra: object = {}) => ({ name, entity: 'LEAD', trigger: 'CREATE', actions: [{ type: 'NOTIFY', recipient: mgr.user.id, message: '提醒' }], ...extra });
const create = (body: object, token = a.token) => call(workflows.POST, { token, body });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
});

describe('workflows R2 concurrency', () => {
  it('20 个并发新建：执行次数 20、通知 20 条 / concurrent creates', async () => {
    const r = (await create(rule('并发'))).json;
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => call(leads.POST, { token: a.token, body: { name: `并发${i}` } })));
    expect(res.every((x) => x.status === 201)).toBe(true);
    expect((await prisma.workflowRule.findUniqueOrThrow({ where: { id: r.id } })).runCount).toBe(20);
    expect(await prisma.notification.count({ where: { userId: mgr.user.id, type: 'WORKFLOW' } })).toBe(20);
    expect(await prisma.auditLog.count({ where: { action: 'workflow.run' } })).toBe(20);
  });

  it('上限 98 条时 5 个并发新建：只有 2 个成功 / the cap holds under concurrency', async () => {
    await prisma.workflowRule.createMany({
      data: Array.from({ length: 98 }, (_, i) => ({ organizationId: a.org.id, name: `r${i}`, entity: 'LEAD' as const, trigger: 'CREATE' as const, actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }], isActive: false })),
    });
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => create(rule(`并发上限${i}`))));
    expect(res.filter((x) => x.status === 201)).toHaveLength(2);
    expect(res.filter((x) => x.status === 409)).toHaveLength(3);
    expect(await prisma.workflowRule.count({ where: { organizationId: a.org.id } })).toBe(100);
  });
});

describe('workflows R2 isolation and safety', () => {
  it('组织隔离：B 的规则不在 A 执行；被篡改为他组织用户的动作被跳过 / tenant isolation', async () => {
    const b = await createTenant('B');
    const bMgr = await addUser(b.org.id, 'MANAGER', 'B经理');
    expect((await create({ ...rule('B 规则'), actions: [{ type: 'NOTIFY', recipient: bMgr.user.id, message: 'B' }] }, b.token)).status).toBe(201);
    await call(leads.POST, { token: a.token, body: { name: 'A 线索' } });
    expect(await prisma.notification.count({ where: { userId: bMgr.user.id } })).toBe(0);
    // 绕过接口把 A 的规则改成通知 B 的用户、指派给 B 的用户 → 跳过 / tampered cross-org users are skipped
    const r = (await create(rule('A 规则'))).json;
    await prisma.workflowRule.update({ where: { id: r.id }, data: { actions: [{ type: 'NOTIFY', recipient: bMgr.user.id, message: 'x' }, { type: 'ASSIGN_OWNER', userId: bMgr.user.id }] } });
    const lead = (await call(leads.POST, { token: a.token, body: { name: 'A 线索 2' } })).json;
    expect(lead.ownerId).toBe(a.user.id);
    expect(await prisma.notification.count({ where: { userId: bMgr.user.id } })).toBe(0);
    const run = await prisma.auditLog.findFirstOrThrow({ where: { action: 'workflow.run', organizationId: a.org.id }, orderBy: { createdAt: 'desc' } });
    expect(run.changes).toMatchObject({ skipped: ['NOTIFY: user_inactive', 'ASSIGN_OWNER: user_inactive'] });
  });

  it('数据库约束；损坏的规则数据被安全跳过，写入照常 / database checks and corrupted rules', async () => {
    const r = (await create(rule('约束'))).json;
    const bad = [
      prisma.$executeRaw`UPDATE workflow_rules SET trigger = 'FIELD_CHANGE' WHERE id = ${r.id}::uuid`,
      prisma.$executeRaw`UPDATE workflow_rules SET trigger_field = 'status' WHERE id = ${r.id}::uuid`,
      prisma.$executeRaw`UPDATE workflow_rules SET actions = '[]'::jsonb WHERE id = ${r.id}::uuid`,
      prisma.$executeRaw`UPDATE workflow_rules SET conditions = '{}'::jsonb WHERE id = ${r.id}::uuid`,
      prisma.$executeRaw`UPDATE workflow_rules SET name = '  ' WHERE id = ${r.id}::uuid`,
      prisma.$executeRaw`UPDATE workflow_rules SET run_count = -1 WHERE id = ${r.id}::uuid`,
    ];
    for (const q of bad) await expect(q).rejects.toThrow(/workflow_rules_check/);
    await expect(prisma.workflowRule.create({ data: { organizationId: a.org.id, name: '约束'.toUpperCase(), entity: 'LEAD', trigger: 'CREATE', actions: [{}] } })).rejects.toThrow();
    // 绕过校验写入无法识别的动作 → 整条规则跳过，线索照常创建 / unrecognised actions → the rule is skipped, the lead is created
    await prisma.workflowRule.update({ where: { id: r.id }, data: { actions: [{ type: 'SEND_EMAIL', to: 'x' }] } });
    const res = await call(leads.POST, { token: a.token, body: { name: '照常' } });
    expect(res.status).toBe(201);
    expect(await prisma.auditLog.count({ where: { action: 'workflow.run' } })).toBe(0);
  });

  it('通知中心显示工作流提醒；审计日志按对象筛选 / notification centre and audit filter', async () => {
    await create(rule('提醒经理'));
    await call(leads.POST, { token: a.token, body: { name: '某线索' } });
    const list = (await call(notifications.GET, { token: mgr.token })).json;
    expect(list.items).toMatchObject([{ type: 'WORKFLOW', title: '提醒 · 某线索', leadId: expect.any(String), actor: { id: a.user.id } }]);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'workflow' } })).json;
    expect(logs.items.map((l: { action: string }) => l.action)).toEqual(['workflow.run', 'workflow.create']);
  });

  it('100 条启用规则：新建线索 3 秒内完成 / 100 active rules', async () => {
    await prisma.workflowRule.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        organizationId: a.org.id,
        name: `规则${i}`,
        entity: 'LEAD' as const,
        trigger: 'CREATE' as const,
        conditions: [{ field: 'company', op: 'CONTAINS', value: i % 2 ? '汽配' : '电子' }],
        actions: [{ type: 'NOTIFY', recipient: mgr.user.id, message: `提醒${i}` }],
      })),
    });
    const t0 = Date.now();
    const res = await call(leads.POST, { token: a.token, body: { name: '性能', company: '宁波汽配' } });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.status).toBe(201);
    expect(await prisma.notification.count({ where: { userId: mgr.user.id } })).toBe(50);
  });
});

describe('workflows R2 demo', () => {
  it('演示规则：通过校验；商机进入商务谈判时创建合同任务并通知经理 / demo rules', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rules = await prisma.workflowRule.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
    expect(rules.map((r) => [r.name, r.isActive])).toEqual(DEMO_WORKFLOWS.map((w) => [w.name, w.isActive]));
    for (const r of rules) expect(workflowCreateSchema.safeParse({ name: r.name, entity: r.entity, trigger: r.trigger, triggerField: r.triggerField, conditions: r.conditions, actions: r.actions, isActive: r.isActive }).success, r.name).toBe(true);
    const manager = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'MANAGER' } });
    const deal = await prisma.deal.findFirstOrThrow({ where: { organizationId: org.id, stage: 'PROPOSAL' } });
    const ctx = { organizationId: org.id, userId: manager.id, role: 'MANAGER' } as never;
    const updated = await updateDeal(ctx, deal.id, { stage: 'NEGOTIATION' });
    expect(updated.stage).toBe('NEGOTIATION');
    expect(await prisma.activity.count({ where: { dealId: deal.id, subject: '【演示】准备合同草稿' } })).toBe(1);
    // 经理自己改的也收到工作流通知（通知动作不排除操作人）/ the manager gets the workflow notice even as the actor
    expect(await prisma.notification.count({ where: { dealId: deal.id, userId: manager.id, type: 'WORKFLOW', title: { startsWith: '商机进入商务谈判' } } })).toBe(1);
    expect((await prisma.workflowRule.findFirstOrThrow({ where: { organizationId: org.id, name: DEMO_WORKFLOWS[1]!.name } })).runCount).toBe(1);
  });
});
