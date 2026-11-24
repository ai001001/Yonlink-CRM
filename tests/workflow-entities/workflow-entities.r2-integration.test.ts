/**
 * 客户与工单工作流 第二轮：集成测试（门户新建工单触发且没有操作人；3 个进程并发处理客户无跟进：每个客户只提醒一次；
 * 500 个客户分批；数据库约束；组织隔离；导入客户不触发；演示规则）。
 * Account and ticket workflows round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DEMO_ORG_NAME, DEMO_WORKFLOWS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountImport from '@/app/api/accounts/import/route';
import * as accounts from '@/app/api/accounts/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as portalInvite from '@/app/api/contacts/[id]/portal/invite/route';
import * as accept from '@/app/api/portal/auth/accept/route';
import * as portalTickets from '@/app/api/portal/tickets/route';
import * as settings from '@/app/api/portal-settings/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as workflows from '@/app/api/workflows/route';
import { hashToken } from '@/server/auth';
import { prisma } from '@/server/db';
import { sweepScheduledWorkflows } from '@/server/modules/workflow-schedule';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const rule = (body: object, token = a.token) => call(workflows.POST, { token, body: { name: `规则${Math.random()}`, conditions: [], ...body } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('account and ticket workflows R2', () => {
  it('门户新建工单触发工作流，没有操作人 / portal tickets fire workflows', async () => {
    const mgr = await addUser(a.org.id, 'MANAGER', '经理');
    await rule({ entity: 'TICKET', trigger: 'CREATE', conditions: [{ field: 'channel', op: 'EQUALS', value: 'PORTAL' }], actions: [{ type: 'NOTIFY', recipient: mgr.user.id, message: '门户工单' }, { type: 'UPDATE_FIELD', field: 'priority', value: 'HIGH' }] });
    await call(settings.PATCH, { token: a.token, body: { isEnabled: true }, method: 'PATCH' });
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const c = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '陈客户', email: 'chen@example.com' } })).json;
    const inv = (await call(portalInvite.POST, { token: a.token, params: { id: c.id } })).json;
    const pt = (await call(accept.POST, { body: { token: inv.token, password: 'Portal-pass-123' } })).json.token;
    const t = (await call(portalTickets.POST, { token: pt, body: { subject: '门户问题' } })).json;
    expect(t).toMatchObject({ priority: 'HIGH' }); // 返回工作流修改后的工单 / the response reflects the workflow
    expect(await prisma.notification.findFirstOrThrow({ where: { ticketId: t.id, type: 'WORKFLOW' } })).toMatchObject({ userId: mgr.user.id, actorId: null });
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'workflow.run' } })).toMatchObject({ actorId: null });
  });

  it('3 个进程并发处理客户无跟进：每个客户只提醒一次；500 个分批 / concurrent and batched account inactivity', async () => {
    await rule({ entity: 'ACCOUNT', trigger: 'INACTIVITY', triggerDays: 7, actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '久未跟进' }] });
    await prisma.account.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ organizationId: a.org.id, ownerId: a.user.id, name: `客户${i}`, createdAt: new Date(Date.now() - 10 * 86_400_000) })) });
    const t0 = Date.now();
    const results = await Promise.all([sweepScheduledWorkflows(), sweepScheduledWorkflows(), sweepScheduledWorkflows()]);
    // 每条规则每次最多 500 条，并发的进程合计处理不超过 600 且不重复 / at most 500 per rule per run; no duplicates
    const ran = results.reduce((s, r) => s + r.ran, 0);
    expect(ran).toBeLessThanOrEqual(600);
    expect(await prisma.notification.count({ where: { type: 'WORKFLOW' } })).toBe(ran);
    await sweepScheduledWorkflows();
    expect(await prisma.notification.count({ where: { type: 'WORKFLOW' } })).toBe(600);
    expect(await prisma.workflowScheduleRun.count()).toBe(600);
    expect(Date.now() - t0).toBeLessThan(90_000);
  }, 120_000);

  it('数据库约束；组织隔离；导入客户不触发 / constraints, isolation, imports', async () => {
    const r = (await rule({ entity: 'TICKET', trigger: 'CREATE', actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] })).json;
    await expect(prisma.$executeRaw`UPDATE workflow_rules SET trigger = 'INACTIVITY', trigger_days = 7 WHERE id = ${r.id}::uuid`).rejects.toThrow(/workflow_rules_entity_trigger_check/);
    // 宏、流程蓝图、销售节奏、验证规则各建一条线索记录，改为客户或工单均被拒绝 / one lead row each; switching to account/ticket is refused
    await prisma.macro.create({ data: { organizationId: a.org.id, name: 'm', entity: 'LEAD', scope: 'PERSONAL', createdById: a.user.id, actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'NEW' }] } });
    await prisma.blueprint.create({ data: { organizationId: a.org.id, name: 'b', entity: 'LEAD', transitions: [{ name: 't', from: ['NEW'], to: 'CONTACTED', roles: ['ADMIN'] }], createdById: a.user.id } });
    await prisma.cadence.create({ data: { organizationId: a.org.id, name: 'c', entity: 'LEAD', steps: [{ day: 0, type: 'CALL', subject: 's' }], createdById: a.user.id } });
    const v = await call((await import('@/app/api/validation-rules/route')).POST, { token: a.token, body: { name: 'v', entity: 'LEAD', require: [{ field: 'phone', op: 'NOT_EMPTY' }], message: 'm' } });
    expect(v.status).toBe(201);
    for (const [table, check] of [['macros', 'macros_entity_check'], ['blueprints', 'blueprints_entity_check'], ['cadences', 'cadences_entity_check'], ['validation_rules', 'validation_rules_entity_check']] as const) {
      await expect(prisma.$executeRawUnsafe(`UPDATE ${table} SET entity = 'ACCOUNT' WHERE organization_id = $1::uuid`, a.org.id)).rejects.toThrow(new RegExp(check));
      await expect(prisma.$executeRawUnsafe(`UPDATE ${table} SET entity = 'TICKET' WHERE organization_id = $1::uuid`, a.org.id)).rejects.toThrow(new RegExp(check));
    }
    // 组织隔离：B 的客户规则不对 A 触发 / isolation
    const b = await createTenant('B');
    await rule({ entity: 'ACCOUNT', trigger: 'CREATE', actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'B 新客户' }] }, b.token);
    await call(accounts.POST, { token: a.token, body: { name: 'A 客户' } });
    expect(await prisma.notification.count({ where: { type: 'WORKFLOW' } })).toBe(0);
    await call(accounts.POST, { token: b.token, body: { name: 'B 客户' } });
    expect(await prisma.notification.count({ where: { organizationId: b.org.id, type: 'WORKFLOW' } })).toBe(1);
    // 导入不触发（与线索导入一致）/ imports do not fire (as with lead imports)
    await call(accountImport.POST, { token: b.token, body: { csv: '客户名称\n导入甲\n导入乙', dryRun: false } });
    expect(await prisma.notification.count({ where: { organizationId: b.org.id, type: 'WORKFLOW' } })).toBe(1);
  });

  it('演示规则：客户新建建拜访任务；工单升为紧急通知经理 / demo rules', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    expect((await prisma.workflowRule.findMany({ where: { organizationId: org.id } })).map((r) => r.name).sort()).toEqual(DEMO_WORKFLOWS.map((w) => w.name).sort());
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.yonlink.test' } });
    const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'manager@demo.yonlink.test' } });
    const token = randomBytes(32).toString('base64url');
    await prisma.session.create({ data: { userId: admin.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
    const acc = (await call(accounts.POST, { token, body: { name: '【演示】测试新客户' } })).json;
    expect(await prisma.activity.findMany({ where: { accountId: acc.id }, select: { subject: true } })).toEqual([{ subject: '【演示】安排首次拜访，了解采购计划' }]);
    const t = await prisma.ticket.findFirstOrThrow({ where: { organizationId: org.id, priority: { not: 'URGENT' }, status: { in: ['OPEN', 'IN_PROGRESS'] } } });
    expect((await call(ticketItem.PATCH, { token, params: { id: t.id }, body: { priority: 'URGENT' }, method: 'PATCH' })).status).toBe(200);
    expect(await prisma.notification.findFirstOrThrow({ where: { ticketId: t.id, type: 'WORKFLOW' } })).toMatchObject({ userId: manager.id });
  });
});
