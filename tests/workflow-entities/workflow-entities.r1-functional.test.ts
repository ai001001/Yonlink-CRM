/**
 * 客户与工单工作流 第一轮：功能测试（维护：客户与工单规则的校验，工单不能用“无跟进”与加标签，工单状态只能改为未完成状态；
 * 宏、流程蓝图、销售节奏、验证规则仍只接受线索与商机；执行：客户新建与字段变化、工单新建与优先级变化、更新字段、指派、任务、
 * 通知、标签、Webhook 字段；门户工单也触发；定时：客户无跟进、工单处理期限前、客户创建日后）。
 * Account and ticket workflows round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as blueprints from '@/app/api/blueprints/route';
import * as cadences from '@/app/api/cadences/route';
import * as macros from '@/app/api/macros/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import * as validation from '@/app/api/validation-rules/route';
import * as webhooks from '@/app/api/webhooks/route';
import * as workflows from '@/app/api/workflows/route';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { sweepScheduledWorkflows } from '@/server/modules/workflow-schedule';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;
const rule = (body: object) => call(workflows.POST, { token: a.token, body: { name: `规则${Math.random()}`, conditions: [], ...body } });
const notify = (message = '提醒', recipient: string = 'OWNER') => ({ type: 'NOTIFY', recipient, message });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('account and ticket workflows R1 maintenance', () => {
  it('客户与工单规则的校验；其他模块仍只接受线索与商机 / validation', async () => {
    expect((await rule({ entity: 'ACCOUNT', trigger: 'FIELD_CHANGE', triggerField: 'industry', actions: [notify()] })).status).toBe(201);
    expect((await rule({ entity: 'ACCOUNT', trigger: 'INACTIVITY', triggerDays: 30, actions: [notify()] })).status).toBe(201);
    expect((await rule({ entity: 'TICKET', trigger: 'FIELD_CHANGE', triggerField: 'priority', actions: [notify()] })).status).toBe(201);
    expect((await rule({ entity: 'TICKET', trigger: 'DATE_RELATIVE', triggerField: 'dueAt', triggerDays: -1, actions: [notify()] })).status).toBe(201);
    const bad: object[] = [
      { entity: 'TICKET', trigger: 'INACTIVITY', triggerDays: 7, actions: [notify()] },
      { entity: 'TICKET', trigger: 'CREATE', actions: [{ type: 'ADD_TAG', tagId: crypto.randomUUID() }] },
      { entity: 'TICKET', trigger: 'CREATE', actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'RESOLVED' }] },
      { entity: 'TICKET', trigger: 'FIELD_CHANGE', triggerField: 'subject', actions: [notify()] },
      { entity: 'TICKET', trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate', triggerDays: 1, actions: [notify()] },
      { entity: 'ACCOUNT', trigger: 'FIELD_CHANGE', triggerField: 'stage', actions: [notify()] },
      { entity: 'ACCOUNT', trigger: 'CREATE', conditions: [{ field: 'industry', op: 'EQUALS', value: 'SPACE' }], actions: [notify()] },
      { entity: 'ACCOUNT', trigger: 'CREATE', actions: [{ type: 'UPDATE_FIELD', field: 'name', value: 'x' }] },
      { entity: 'CONTACT', trigger: 'CREATE', actions: [notify()] },
    ];
    for (const [i, b] of bad.entries()) expect((await rule({ name: `非法${i}`, ...b })).status, JSON.stringify(b)).toBe(400);
    // 宏、流程蓝图、销售节奏、验证规则仍只接受线索与商机 / other modules stay lead/deal only
    expect((await call(macros.POST, { token: a.token, body: { name: '宏', entity: 'ACCOUNT', actions: [{ type: 'ASSIGN_OWNER', userId: a.user.id }] } })).status).toBe(400);
    expect((await call(blueprints.POST, { token: a.token, body: { name: '蓝图', entity: 'TICKET', transitions: [{ name: 't', from: ['OPEN'], to: 'CLOSED', roles: ['ADMIN'] }] } })).status).toBe(400);
    expect((await call(cadences.POST, { token: a.token, body: { name: '节奏', entity: 'ACCOUNT', steps: [{ day: 0, type: 'CALL', subject: 's' }] } })).status).toBe(400);
    expect((await call(validation.POST, { token: a.token, body: { name: '验证', entity: 'TICKET', require: [{ field: 'subject', op: 'NOT_EMPTY' }], message: 'm' } })).status).toBe(400);
    expect((await call(workflows.GET, { token: a.token, query: { entity: 'TICKET' } })).json.items).toHaveLength(2);
  });
});

describe('account and ticket workflows R1 runs', () => {
  it('客户：新建建任务；行业变化时通知、加标签、指派；Webhook 字段；工作流改动不再触发 / accounts', async () => {
    const tag = await prisma.tag.create({ data: { organizationId: a.org.id, name: 'IT 客户', nameKey: 'it 客户' } });
    const created = await call(webhooks.POST, { token: a.token, body: { name: '钩子', url: 'https://example.com/hook' } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const hook = created.json;
    await rule({ entity: 'ACCOUNT', trigger: 'CREATE', actions: [{ type: 'CREATE_TASK', subject: '首次拜访', dueInDays: 7, assignTo: 'OWNER' }] });
    await rule({
      entity: 'ACCOUNT',
      trigger: 'FIELD_CHANGE',
      triggerField: 'industry',
      conditions: [{ field: 'industry', op: 'EQUALS', value: 'IT' }],
      actions: [notify('转为 IT 行业'), { type: 'ADD_TAG', tagId: tag.id }, { type: 'ASSIGN_OWNER', userId: mgr.user.id }, { type: 'WEBHOOK', webhookId: hook.id }],
    });
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '远望', ownerId: sales.user.id } })).json;
    expect(await prisma.activity.findMany({ where: { accountId: acc.id }, select: { subject: true, ownerId: true } })).toEqual([{ subject: '首次拜访', ownerId: sales.user.id }]);
    const upd = await call(accountItem.PATCH, { token: a.token, params: { id: acc.id }, body: { industry: 'IT' }, method: 'PATCH' });
    expect(upd.json.ownerId).toBe(mgr.user.id); // 返回的是工作流修改后的记录 / the response reflects workflow changes
    expect(await prisma.notification.count({ where: { accountId: acc.id, type: 'WORKFLOW', userId: sales.user.id } })).toBe(1);
    expect(await prisma.accountTag.count({ where: { accountId: acc.id, tagId: tag.id } })).toBe(1);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'account', entityId: acc.id, action: 'account.update', changes: { path: ['workflow'], not: Prisma.DbNull } } });
    expect(log.changes).toMatchObject({ fields: { ownerId: [sales.user.id, mgr.user.id] } });
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { webhookId: hook.id } });
    expect((d.payload as { data: { entity: string; record: Record<string, unknown> } }).data).toMatchObject({ entity: 'ACCOUNT', record: { id: acc.id, name: '远望', industry: 'IT', ownerId: mgr.user.id } });
    expect(Object.keys((d.payload as { data: { record: object } }).data.record).sort()).toEqual(['id', 'industry', 'name', 'ownerId', 'score', 'territoryId']);
    // 工作流修改负责人不会再次触发（只执行一次）/ workflow changes do not fire again
    expect((await prisma.workflowRule.findMany({ select: { runCount: true }, orderBy: { createdAt: 'asc' } })).map((r) => r.runCount)).toEqual([1, 1]);
  });

  it('工单：新建与优先级变化；更新状态、指派、任务关联客户、通知；已解决改回处理中清除解决时间 / tickets', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', ownerId: sales.user.id } })).json;
    await rule({ entity: 'TICKET', trigger: 'CREATE', conditions: [{ field: 'channel', op: 'EQUALS', value: 'EMAIL' }], actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'IN_PROGRESS' }, { type: 'ASSIGN_OWNER', userId: sales.user.id }] });
    await rule({ entity: 'TICKET', trigger: 'FIELD_CHANGE', triggerField: 'priority', conditions: [{ field: 'priority', op: 'EQUALS', value: 'URGENT' }], actions: [notify('紧急工单', mgr.user.id), { type: 'CREATE_TASK', subject: '电话回访', dueInDays: 0, assignTo: 'OWNER' }, { type: 'UPDATE_FIELD', field: 'status', value: 'IN_PROGRESS' }] });
    const t1 = (await call(tickets.POST, { token: a.token, body: { subject: '邮件来的', accountId: acc.id, channel: 'EMAIL' } })).json;
    expect(t1).toMatchObject({ status: 'IN_PROGRESS', ownerId: sales.user.id });
    const t2 = (await call(tickets.POST, { token: a.token, body: { subject: '电话来的', accountId: acc.id } })).json;
    expect(t2.status).toBe('OPEN');
    // 已解决的工单升为紧急：状态改回处理中、清除解决时间（满足原有约束）/ a resolved ticket made urgent reopens and clears resolvedAt
    await call(ticketItem.PATCH, { token: a.token, params: { id: t2.id }, body: { status: 'RESOLVED', resolution: '已处理' }, method: 'PATCH' });
    const up = await call(ticketItem.PATCH, { token: a.token, params: { id: t2.id }, body: { priority: 'URGENT' }, method: 'PATCH' });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t2.id } })).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null, priority: 'URGENT' });
    expect(await prisma.notification.findMany({ where: { ticketId: t2.id, type: 'WORKFLOW' }, select: { userId: true, title: true } })).toEqual([{ userId: mgr.user.id, title: expect.stringContaining('紧急工单 · ') }]);
    expect(await prisma.activity.findMany({ where: { accountId: acc.id, subject: '电话回访' }, select: { ownerId: true } })).toEqual([{ ownerId: a.user.id }]); // 工单负责人默认为新建人 / the ticket owner defaults to its creator
    const run = await prisma.auditLog.findFirstOrThrow({ where: { action: 'workflow.run', changes: { path: ['entity'], equals: 'TICKET' } }, orderBy: { createdAt: 'desc' } });
    expect(run.changes).toMatchObject({ record: expect.stringMatching(/ 电话来的$/) });
  });

  it('定时：客户无跟进、工单处理期限前一天、客户创建后 / scheduled', async () => {
    await rule({ entity: 'ACCOUNT', trigger: 'INACTIVITY', triggerDays: 7, actions: [notify('客户久未跟进')] });
    await rule({ entity: 'TICKET', trigger: 'DATE_RELATIVE', triggerField: 'dueAt', triggerDays: -1, actions: [notify('工单明天到期', mgr.user.id)] });
    await rule({ entity: 'ACCOUNT', trigger: 'DATE_RELATIVE', triggerField: 'createdAt', triggerDays: 3, actions: [notify('新客户第 3 天')] });
    const old = await prisma.account.create({ data: { organizationId: a.org.id, name: '老客户', ownerId: sales.user.id, createdAt: new Date(Date.now() - 10 * 86_400_000) } });
    const touched = await prisma.account.create({ data: { organizationId: a.org.id, name: '有跟进', ownerId: sales.user.id, createdAt: new Date(Date.now() - 10 * 86_400_000) } });
    await prisma.activity.create({ data: { organizationId: a.org.id, type: 'CALL', subject: '电话', accountId: touched.id, ownerId: sales.user.id } });
    const recent = await prisma.account.create({ data: { organizationId: a.org.id, name: '三天前', ownerId: sales.user.id, createdAt: new Date(Date.now() - 3 * 86_400_000) } });
    const tomorrow = new Date(Date.now() + 86_400_000);
    const t = await prisma.ticket.create({ data: { organizationId: a.org.id, ticketNumber: 'T-1', subject: '明天到期', accountId: old.id, dueAt: tomorrow } });
    await prisma.ticket.create({ data: { organizationId: a.org.id, ticketNumber: 'T-2', subject: '下周到期', accountId: old.id, dueAt: new Date(Date.now() + 7 * 86_400_000) } });
    const r = await sweepScheduledWorkflows();
    expect(r.failures).toEqual([]);
    const notes = await prisma.notification.findMany({ where: { type: 'WORKFLOW' }, select: { accountId: true, ticketId: true, title: true } });
    expect(notes.filter((n) => n.title.startsWith('客户久未跟进')).map((n) => n.accountId)).toEqual([old.id]);
    expect(notes.filter((n) => n.title.startsWith('工单明天到期')).map((n) => n.ticketId)).toEqual([t.id]);
    expect(notes.filter((n) => n.title.startsWith('新客户第 3 天')).map((n) => n.accountId)).toEqual([recent.id]);
    expect((await sweepScheduledWorkflows()).ran).toBe(0); // 同一触发键只执行一次 / once per key
  });
});
