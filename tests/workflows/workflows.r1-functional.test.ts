/**
 * 工作流规则 第一轮：功能测试（规则维护：新建、校验、同名、上限、修改、启停、对象不可改、删除、权限、审计；
 * 触发时机：新建、编辑、新建或编辑、字段变化；条件：枚举、文本、数字、负责人、为空；动作：更新字段、指派、创建任务、通知、加标签；
 * 跳过不可用目标；工作流改动不再触发工作流；多条规则按创建顺序执行；执行次数与审计；网页表单线索触发；停用规则不执行）。
 * Workflow rules round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as deals from '@/app/api/deals/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as publicForm from '@/app/api/public/web-forms/[key]/route';
import * as tagsRoute from '@/app/api/tags/route';
import * as forms from '@/app/api/web-forms/route';
import * as wfItem from '@/app/api/workflows/[id]/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { conditionHolds } from '@/server/modules/workflows';
import { resetWebFormLimiter } from '@/server/modules/web-forms';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let acc: { id: string };

const create = (body: object, token = a.token) => call(workflows.POST, { token, body: { name: '规则', entity: 'LEAD', trigger: 'CREATE', actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '提醒' }], ...body } });
const patchRule = (id: string, body: object, token = a.token) => call(wfItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const newLead = async (body: object = {}, token = a.token) => (await call(leads.POST, { token, body: { name: '线索', ...body } })).json;
const newDeal = async (body: object = {}) => (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, amount: '1000', ...body } })).json;
const runs = (action = 'workflow.run') => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await resetDb();
  resetWebFormLimiter();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
});

describe('workflows R1 conditions', () => {
  it('条件：枚举等于/不等于、文本、数字、负责人、为空 / conditions', () => {
    const lead = { status: 'NEW', source: 'WEBSITE', company: ' Acme 汽配 ', email: null, score: 55, ownerId: 'u1', campaignId: null };
    expect(conditionHolds('LEAD', { field: 'status', op: 'EQUALS', value: 'NEW' }, lead)).toBe(true);
    expect(conditionHolds('LEAD', { field: 'status', op: 'NOT_EQUALS', value: 'NEW' }, lead)).toBe(false);
    expect(conditionHolds('LEAD', { field: 'company', op: 'CONTAINS', value: '汽配' }, lead)).toBe(true);
    expect(conditionHolds('LEAD', { field: 'company', op: 'STARTS_WITH', value: 'acme' }, lead)).toBe(true);
    expect(conditionHolds('LEAD', { field: 'company', op: 'ENDS_WITH', value: 'acme' }, lead)).toBe(false);
    expect(conditionHolds('LEAD', { field: 'email', op: 'IS_EMPTY' }, lead)).toBe(true);
    expect(conditionHolds('LEAD', { field: 'email', op: 'CONTAINS', value: 'x' }, lead)).toBe(false);
    expect(conditionHolds('LEAD', { field: 'score', op: 'GTE', value: '55' }, lead)).toBe(true);
    expect(conditionHolds('LEAD', { field: 'score', op: 'LTE', value: '54.99' }, lead)).toBe(false);
    expect(conditionHolds('LEAD', { field: 'ownerId', op: 'EQUALS', value: 'u1' }, lead)).toBe(true);
    expect(conditionHolds('LEAD', { field: 'campaignId', op: 'NOT_EMPTY' }, lead)).toBe(false);
    expect(conditionHolds('DEAL', { field: 'amount', op: 'GTE', value: '500000' }, { amount: '500000.00' })).toBe(true);
    expect(conditionHolds('DEAL', { field: 'company', op: 'EQUALS', value: 'x' }, { company: 'x' })).toBe(false);
  });
});

describe('workflows R1 maintenance', () => {
  it('新建、校验、同名、修改、启停、对象不可改、删除、权限、审计 / maintenance', async () => {
    const r = await create({ name: '高分提醒', conditions: [{ field: 'score', op: 'GTE', value: '50' }] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '高分提醒', entity: 'LEAD', trigger: 'CREATE', triggerField: null, isActive: true, runCount: 0, createdBy: { id: a.user.id } });
    expect((await create({ name: ' 高分提醒 ' })).status).toBe(409);
    expect((await create({ name: '高分提醒'.replace('高', '高') })).json.error.details).toEqual({ name: ['taken'] });

    const b = await createTenant('B');
    const bad: object[] = [
      { name: '' },
      { entity: 'TICKET' },
      { trigger: 'FIELD_CHANGE' },
      { trigger: 'FIELD_CHANGE', triggerField: 'name' },
      { trigger: 'CREATE', triggerField: 'status' },
      { conditions: [{ field: 'stage', op: 'EQUALS', value: 'PROPOSAL' }] },
      { conditions: [{ field: 'status', op: 'CONTAINS', value: 'NEW' }] },
      { conditions: [{ field: 'status', op: 'EQUALS', value: 'NOPE' }] },
      { conditions: [{ field: 'score', op: 'GTE', value: 'abc' }] },
      { conditions: [{ field: 'email', op: 'IS_EMPTY', value: 'x' }] },
      { conditions: [{ field: 'company', op: 'CONTAINS' }] },
      { conditions: [{ field: 'ownerId', op: 'EQUALS', value: 'not-uuid' }] },
      { conditions: Array.from({ length: 6 }, () => ({ field: 'company', op: 'CONTAINS', value: 'a' })) },
      { actions: [] },
      { actions: Array.from({ length: 6 }, () => ({ type: 'NOTIFY', recipient: 'OWNER', message: 'x' })) },
      { actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'CONVERTED' }] },
      { actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'PROPOSAL' }] },
      { actions: [{ type: 'UPDATE_FIELD', field: 'ownerId', value: 'x' }] },
      { actions: [{ type: 'CREATE_TASK', subject: 'x', dueInDays: 400, assignTo: 'OWNER' }] },
      { actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '' }] },
      { actions: [{ type: 'SEND_EMAIL' }] },
      { actions: [{ type: 'ASSIGN_OWNER', userId: b.user.id }] },
      { actions: [{ type: 'ADD_TAG', tagId: '00000000-0000-4000-8000-000000000000' }] },
      { runCount: 5 },
    ];
    for (const [i, body] of bad.entries()) expect((await create({ name: `非法${i}`, ...body })).status, JSON.stringify(body)).toBe(400);

    // 修改：只启停；整体修改；对象不可改 / toggle only; full update; the entity is fixed
    const id = r.json.id;
    expect((await patchRule(id, { isActive: false })).json).toMatchObject({ isActive: false, conditions: [{ field: 'score', op: 'GTE', value: '50' }] });
    expect((await patchRule(id, { name: '改名' })).status).toBe(400);
    const up = await patchRule(id, { name: '状态变化', entity: 'LEAD', trigger: 'FIELD_CHANGE', triggerField: 'status', conditions: [], actions: [{ type: 'NOTIFY', recipient: mgr.user.id, message: '状态变了' }], isActive: true });
    expect(up.json).toMatchObject({ name: '状态变化', trigger: 'FIELD_CHANGE', triggerField: 'status', conditions: [] });
    expect((await patchRule(id, { name: '状态变化', entity: 'DEAL', trigger: 'CREATE', actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] })).json.error.details).toEqual({ entity: ['immutable'] });
    // 改回非字段变化触发时清空触发字段 / switching away from FIELD_CHANGE clears the field
    expect((await patchRule(id, { name: '状态变化', entity: 'LEAD', trigger: 'UPDATE', actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] })).json.triggerField).toBeNull();

    // 权限 / permissions
    expect((await create({ name: '销售' }, rep.token)).status).toBe(403);
    expect((await patchRule(id, { isActive: false }, rep.token)).status).toBe(403);
    expect((await call(workflows.GET, { token: rep.token })).json.total).toBe(1);
    expect((await create({ name: '经理建' }, mgr.token)).status).toBe(201);
    expect((await patchRule(id, { isActive: false }, b.token)).status).toBe(404);
    expect((await call(workflows.GET, { token: b.token })).json.total).toBe(0);
    expect((await call(workflows.GET, { token: a.token, query: { entity: 'DEAL' } })).json.total).toBe(0);

    // 删除与审计 / delete and audit
    expect((await call(wfItem.DELETE, { token: a.token, params: { id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(wfItem.DELETE, { token: a.token, params: { id }, method: 'DELETE' })).status).toBe(404);
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'workflow' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['workflow.create', 'workflow.update', 'workflow.update', 'workflow.update', 'workflow.create', 'workflow.delete']);
    expect(logs[1]!.changes).toEqual({ fields: { isActive: [true, false] } });
    expect((logs[2]!.changes as { fields: Record<string, unknown> }).fields).toMatchObject({ name: ['高分提醒', '状态变化'], trigger: ['CREATE', 'FIELD_CHANGE'], triggerField: [null, 'status'] });
  });

  it('每组织最多 100 条 / at most 100 rules', async () => {
    await prisma.workflowRule.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ organizationId: a.org.id, name: `r${i}`, entity: 'LEAD' as const, trigger: 'CREATE' as const, actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] })) });
    expect((await create({ name: '第 101 条' })).json.error.details).toEqual({ name: ['limit_reached'] });
  });
});

describe('workflows R1 execution', () => {
  it('新建时：通知负责人、创建任务、加标签、指派；不满足条件不执行；审计与次数 / on create', async () => {
    const tag = (await call(tagsRoute.POST, { token: a.token, body: { name: '高分' } })).json;
    const rule = (
      await create({
        name: '高分新线索',
        conditions: [{ field: 'source', op: 'EQUALS', value: 'REFERRAL' }],
        actions: [
          { type: 'NOTIFY', recipient: 'OWNER', message: '请尽快联系' },
          { type: 'CREATE_TASK', subject: '首次电话', dueInDays: 2, assignTo: 'OWNER' },
          { type: 'ADD_TAG', tagId: tag.id },
          { type: 'ASSIGN_OWNER', userId: rep.user.id },
          { type: 'NOTIFY', recipient: 'OWNER', message: '已指派给你' },
        ],
      })
    ).json;
    const lead = await newLead({ source: 'REFERRAL' });
    // 返回的是工作流执行后的记录 / the response reflects the workflow changes
    expect(lead.ownerId).toBe(rep.user.id);
    expect(lead.tags.map((x: { tag: { id: string } }) => x.tag.id)).toEqual([tag.id]);
    // 第一个通知发给当时的负责人（创建人自己），指派后通知发给新负责人 / the first notice goes to the creator, the second to the new owner
    const notes = await prisma.notification.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: 'asc' } });
    expect(notes.map((n) => [n.userId, n.type, n.title])).toEqual([
      [a.user.id, 'WORKFLOW', '请尽快联系 · 线索'],
      [rep.user.id, 'ASSIGNED', '线索'],
      [rep.user.id, 'WORKFLOW', '已指派给你 · 线索'],
    ]);
    const task = await prisma.activity.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(task).toMatchObject({ type: 'TASK', subject: '首次电话', ownerId: a.user.id, completed: false });
    expect(Math.round((task.dueAt!.getTime() - Date.now()) / 86_400_000)).toBe(2);
    // 不满足条件 / no match
    const other = await newLead({ source: 'WEBSITE' });
    expect(await prisma.activity.count({ where: { leadId: other.id } })).toBe(0);
    // 次数与审计 / run count and audit
    expect((await prisma.workflowRule.findUniqueOrThrow({ where: { id: rule.id } })).runCount).toBe(1);
    const [run] = await runs();
    expect(run!.changes).toEqual({ rule: '高分新线索', entity: 'LEAD', recordId: lead.id, record: '线索', actions: ['NOTIFY', 'CREATE_TASK', 'ADD_TAG', 'ASSIGN_OWNER', 'NOTIFY'] });
    expect(run!.actorId).toBe(a.user.id);
    const assigned = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.update', entityId: lead.id } });
    expect(assigned.changes).toEqual({ fields: { ownerId: [a.user.id, rep.user.id] }, workflow: '高分新线索' });
  });

  it('编辑时、字段变化时、新建或编辑时；工作流改动不再触发；按创建顺序执行 / triggers and ordering', async () => {
    await create({ name: '编辑时', trigger: 'UPDATE', actions: [{ type: 'NOTIFY', recipient: mgr.user.id, message: '编辑' }] });
    await create({ name: '状态变化', trigger: 'FIELD_CHANGE', triggerField: 'status', conditions: [{ field: 'status', op: 'EQUALS', value: 'QUALIFIED' }], actions: [{ type: 'UPDATE_FIELD', field: 'source', value: 'REFERRAL' }] });
    // 来源变化规则：如果工作流改动会触发工作流，上一条改来源会触发它 / would fire if workflow changes re-triggered
    await create({ name: '来源变化', trigger: 'FIELD_CHANGE', triggerField: 'source', actions: [{ type: 'NOTIFY', recipient: mgr.user.id, message: '来源变化' }] });
    await create({ name: '新建或编辑', trigger: 'CREATE_OR_UPDATE', conditions: [{ field: 'source', op: 'EQUALS', value: 'REFERRAL' }], actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'CONTACTED' }] });

    const lead = await newLead({ source: 'WEBSITE' });
    expect((await runs()).length).toBe(0);
    // 改名：只触发“编辑时” / a rename fires only "on edit"
    await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { name: '改名' }, method: 'PATCH' });
    expect((await runs()).map((r) => (r.changes as { rule: string }).rule)).toEqual(['编辑时']);
    // 状态改为已确认：编辑时 → 状态变化（改来源为推荐，不触发“来源变化”）→ 新建或编辑（看到推荐，改状态为已联系）
    // status → QUALIFIED: edit → status change (source → REFERRAL, no re-trigger) → create-or-edit (sees REFERRAL, status → CONTACTED)
    const res = await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { status: 'QUALIFIED' }, method: 'PATCH' });
    expect(res.json).toMatchObject({ status: 'CONTACTED', source: 'REFERRAL' });
    expect((await runs()).map((r) => (r.changes as { rule: string }).rule)).toEqual(['编辑时', '编辑时', '状态变化', '新建或编辑']);
    // 没有变化的编辑不触发 / an edit without changes fires nothing
    await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { status: 'CONTACTED' }, method: 'PATCH' });
    expect((await runs()).length).toBe(4);
    // 停用规则不执行 / inactive rules do not run
    await prisma.workflowRule.updateMany({ data: { isActive: false } });
    await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { name: '再改名' }, method: 'PATCH' });
    expect((await runs()).length).toBe(4);
  });

  it('商机：阶段变化与金额条件、批量改阶段同样触发；改阶段动作写阶段历史 / deals', async () => {
    await create({
      name: '大单谈判',
      entity: 'DEAL',
      trigger: 'FIELD_CHANGE',
      triggerField: 'stage',
      conditions: [
        { field: 'stage', op: 'EQUALS', value: 'NEGOTIATION' },
        { field: 'amount', op: 'GTE', value: '500000' },
      ],
      actions: [
        { type: 'CREATE_TASK', subject: '准备合同', dueInDays: 0, assignTo: mgr.user.id },
        { type: 'NOTIFY', recipient: mgr.user.id, message: '大单进入谈判' },
      ],
    });
    await create({ name: '新商机推进', entity: 'DEAL', trigger: 'CREATE', conditions: [{ field: 'amount', op: 'GTE', value: '1000000' }], actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'NEEDS_ANALYSIS' }] });
    const big = await newDeal({ amount: '2000000' });
    expect(big.stage).toBe('NEEDS_ANALYSIS');
    const history = await prisma.dealStageHistory.findMany({ where: { dealId: big.id }, orderBy: { changedAt: 'asc' } });
    expect(history.map((h) => h.stage)).toEqual(['QUALIFICATION', 'NEEDS_ANALYSIS']);
    const small = await newDeal({ amount: '1000' });
    const res = await call(dealBulk.POST, { token: a.token, body: { action: 'stage', ids: [big.id, small.id], stage: 'NEGOTIATION' } });
    expect(res.json.succeeded).toHaveLength(2);
    expect(await prisma.activity.count({ where: { dealId: big.id, subject: '准备合同', ownerId: mgr.user.id } })).toBe(1);
    expect(await prisma.activity.count({ where: { dealId: small.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { dealId: big.id, userId: mgr.user.id, type: 'WORKFLOW' } })).toBe(1);
    // 再改阶段到同一值不触发 / setting the same stage again fires nothing
    await call(dealItem.PATCH, { token: a.token, params: { id: big.id }, body: { stage: 'NEGOTIATION' }, method: 'PATCH' });
    expect(await prisma.activity.count({ where: { dealId: big.id } })).toBe(1);
  });

  it('跳过不可用目标：停用用户、已删标签、已转化线索、无负责人通知；写入不受影响 / skipped actions', async () => {
    const tag = (await call(tagsRoute.POST, { token: a.token, body: { name: '临时' } })).json;
    await create({
      name: '会跳过',
      trigger: 'CREATE_OR_UPDATE',
      actions: [
        { type: 'ASSIGN_OWNER', userId: rep.user.id },
        { type: 'NOTIFY', recipient: mgr.user.id, message: '给经理' },
        { type: 'ADD_TAG', tagId: tag.id },
        { type: 'CREATE_TASK', subject: '任务', dueInDays: 1, assignTo: mgr.user.id },
      ],
    });
    await prisma.user.updateMany({ where: { id: { in: [rep.user.id, mgr.user.id] } }, data: { isActive: false } });
    await prisma.tag.delete({ where: { id: tag.id } });
    const lead = await newLead({ ownerId: null });
    expect(lead.ownerId).toBeNull();
    const [run] = await runs();
    expect(run!.changes).toMatchObject({ actions: ['CREATE_TASK'], skipped: ['ASSIGN_OWNER: user_inactive', 'NOTIFY: user_inactive', 'ADD_TAG: tag_deleted', 'CREATE_TASK: user_inactive → owner'] });
    // 任务回落给记录负责人（此处为空）/ the task falls back to the record owner (none here)
    expect((await prisma.activity.findFirstOrThrow({ where: { leadId: lead.id } })).ownerId).toBeNull();

    // 无负责人的通知、已转化线索改状态 / no-owner notices and converted leads
    await prisma.workflowRule.deleteMany();
    await create({ name: '改状态', trigger: 'UPDATE', actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'UNQUALIFIED' }, { type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'CONVERTED', convertedAt: new Date() } });
    const r = await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { name: '已转化改名' }, method: 'PATCH' });
    expect(r.json.status).toBe('CONVERTED');
    expect((await runs())[1]!.changes).toMatchObject({ actions: [], skipped: ['UPDATE_FIELD status: converted', 'NOTIFY: no_owner'] });
  });

  it('网页表单生成的线索触发新建时规则（操作人为空）/ web-form leads fire create rules', async () => {
    await create({ name: '表单线索', conditions: [{ field: 'source', op: 'EQUALS', value: 'WEBSITE' }], actions: [{ type: 'NOTIFY', recipient: mgr.user.id, message: '新表单线索' }] });
    const form = (await call(forms.POST, { token: a.token, body: { name: '官网', title: 'T' } })).json;
    expect((await call(publicForm.POST, { params: { key: form.publicKey }, body: { name: '访客' }, headers: { 'x-forwarded-for': '10.3.0.1' } })).status).toBe(200);
    const lead = await prisma.lead.findFirstOrThrow({ where: { name: '访客' } });
    const n = await prisma.notification.findFirstOrThrow({ where: { leadId: lead.id, type: 'WORKFLOW' } });
    expect(n).toMatchObject({ userId: mgr.user.id, actorId: null, title: '新表单线索 · 访客' });
    expect((await runs())[0]!.actorId).toBeNull();
  });
});
