/**
 * 宏 第一轮：功能测试（维护：个人与共享、校验、同名、可见范围与可改范围、上限、修改与对象不可改、删除、审计；
 * 执行：线索与商机的字段、负责人、标签、任务，验证规则与已转化线索的失败、不可见记录、工作流与阶段历史照常生效、
 * 指派权限、停用用户与已删标签、执行次数与审计）。
 * Macros round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import * as deals from '@/app/api/deals/route';
import * as accounts from '@/app/api/accounts/route';
import * as macroItem from '@/app/api/macros/[id]/route';
import * as macroRun from '@/app/api/macros/[id]/run/route';
import * as macros from '@/app/api/macros/route';
import * as tags from '@/app/api/tags/route';
import * as validation from '@/app/api/validation-rules/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { MAX_MACROS, MAX_PERSONAL_MACROS } from '@/server/modules/macros';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let s1: Awaited<ReturnType<typeof addUser>>;
let s2: Awaited<ReturnType<typeof addUser>>;
const newMacro = (body: object, token = a.token) => call(macros.POST, { token, body: { name: '宏', entity: 'LEAD', actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'CONTACTED' }], ...body } });
const patchMacro = (id: string, body: object, token = a.token) => call(macroItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const delMacro = (id: string, token = a.token) => call(macroItem.DELETE, { token, params: { id }, method: 'DELETE' });
const run = (id: string, ids: string[], token = a.token) => call(macroRun.POST, { token, params: { id }, body: { ids } });
const listNames = async (token: string) => ((await call(macros.GET, { token })).json.items as { name: string }[]).map((m) => m.name).sort();
const newLead = async (name: string, token = a.token) => (await call(leads.POST, { token, body: { name } })).json;
const newTag = async (name: string) => (await call(tags.POST, { token: a.token, body: { name } })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  s1 = await addUser(a.org.id, 'SALES', '销售甲');
  s2 = await addUser(a.org.id, 'SALES', '销售乙');
});

describe('macros R1 maintenance', () => {
  it('个人与共享、校验、同名、可见与可改范围、修改、删除、审计 / maintenance', async () => {
    const tag = await newTag('跟进中');
    const p = await newMacro({ name: '甲的宏', actions: [{ type: 'ADD_TAG', tagId: tag.id }, { type: 'ASSIGN_OWNER', userId: s1.user.id }] }, s1.token);
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ name: '甲的宏', scope: 'PERSONAL', entity: 'LEAD', createdBy: { id: s1.user.id }, runCount: 0, editable: true });
    expect((await newMacro({ name: '共享', scope: 'SHARED' }, s1.token)).status).toBe(403);
    const shared = (await newMacro({ name: '共享', scope: 'SHARED', entity: 'DEAL', actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'PROPOSAL' }] }, mgr.token)).json;
    expect((await newMacro({ name: ' 共享 ' }, s2.token)).json.error.details).toEqual({ name: ['taken'] });
    const bad: object[] = [
      { actions: [] },
      { actions: Array.from({ length: 6 }, () => ({ type: 'ADD_TAG', tagId: tag.id })) },
      { actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'PROPOSAL' }] },
      { actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'CONVERTED' }] },
      { actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'NEW' }, { type: 'UPDATE_FIELD', field: 'status', value: 'CONTACTED' }] },
      { actions: [{ type: 'ASSIGN_OWNER', userId: s1.user.id }, { type: 'ASSIGN_OWNER', userId: s2.user.id }] },
      { actions: [{ type: 'ADD_TAG', tagId: tag.id }, { type: 'REMOVE_TAG', tagId: tag.id }] },
      { actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] },
      { actions: [{ type: 'CREATE_TASK', subject: ' ', dueInDays: 1, assignTo: 'OWNER' }] },
      { actions: [{ type: 'CREATE_TASK', subject: '任务', dueInDays: 366, assignTo: 'OWNER' }] },
      { entity: 'ACCOUNT' },
      { scope: 'TEAM' },
    ];
    for (const [i, body] of bad.entries()) expect((await newMacro({ name: `非法${i}`, ...body })).status, JSON.stringify(body)).toBe(400);
    // 引用：其他组织用户、未知标签；销售指派给他人 403 / references and owner.assign
    const b = await createTenant('B');
    expect((await newMacro({ name: '他组织用户', actions: [{ type: 'ASSIGN_OWNER', userId: b.user.id }] })).json.error.details).toEqual({ actions: ['user_not_found'] });
    expect((await newMacro({ name: '未知标签', actions: [{ type: 'ADD_TAG', tagId: crypto.randomUUID() }] })).json.error.details).toEqual({ actions: ['tag_not_found'] });
    expect((await newMacro({ name: '指派他人', actions: [{ type: 'ASSIGN_OWNER', userId: s2.user.id }] }, s1.token)).status).toBe(403);
    expect((await newMacro({ name: '任务给他人', actions: [{ type: 'CREATE_TASK', subject: 'x', dueInDays: 1, assignTo: s2.user.id }] }, s1.token)).status).toBe(403);
    // 可见：个人宏只有创建人；共享宏所有人 / visibility
    expect(await listNames(s1.token)).toEqual(['共享', '甲的宏']);
    expect(await listNames(s2.token)).toEqual(['共享']);
    expect(await listNames(a.token)).toEqual(['共享']); // 管理员也看不到他人的个人宏 / admins too
    expect((await call(macros.GET, { token: s2.token, query: { entity: 'LEAD' } })).json.items).toEqual([]);
    expect((await call(macros.GET, { token: s2.token })).json.items[0].editable).toBe(false);
    expect((await patchMacro(p.json.id, { name: '改' }, s2.token)).status).toBe(404);
    expect((await delMacro(p.json.id, a.token)).status).toBe(404);
    expect((await patchMacro(shared.id, { name: '改' }, s1.token)).status).toBe(403);
    // 修改：对象不可改；改动作需同时提交对象；销售不能改为共享 / update rules
    expect((await patchMacro(p.json.id, { entity: 'DEAL', actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'PROPOSAL' }] }, s1.token)).json.error.details).toEqual({ entity: ['immutable'] });
    expect((await patchMacro(p.json.id, { actions: [{ type: 'ADD_TAG', tagId: tag.id }] }, s1.token)).json.error.details).toEqual({ entity: ['required'] });
    expect((await patchMacro(p.json.id, { scope: 'SHARED' }, s1.token)).status).toBe(403);
    const u = await patchMacro(p.json.id, { name: '甲的宏2', description: '说明', entity: 'LEAD', actions: [{ type: 'UPDATE_FIELD', field: 'source', value: 'REFERRAL' }] }, s1.token);
    expect(u.json).toMatchObject({ name: '甲的宏2', description: '说明', actions: [{ type: 'UPDATE_FIELD', field: 'source', value: 'REFERRAL' }] });
    // 经理把共享宏改为个人：只有创建人可以 / only the creator can make a shared macro personal
    expect((await patchMacro(shared.id, { scope: 'PERSONAL' }, a.token)).json.error.details).toEqual({ scope: ['not_creator'] });
    expect((await patchMacro(shared.id, { scope: 'PERSONAL' }, mgr.token)).json.scope).toBe('PERSONAL');
    expect(await listNames(a.token)).toEqual([]);
    expect((await delMacro(p.json.id, s1.token)).status).toBe(204);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'macro' } })).json.items as { action: string; changes: { fields?: object } }[];
    expect(logs.map((l) => l.action).sort()).toEqual(['macro.create', 'macro.create', 'macro.delete', 'macro.update', 'macro.update']);
    expect(Object.keys(logs.find((l) => l.action === 'macro.update' && l.changes.fields && 'actions' in l.changes.fields)!.changes.fields!).sort()).toEqual(['actions', 'name']);
  });

  it('上限：每人 20 个个人宏、每组织 100 个 / limits', async () => {
    await prisma.macro.createMany({ data: Array.from({ length: MAX_PERSONAL_MACROS }, (_, i) => ({ organizationId: a.org.id, name: `个人${i}`, entity: 'LEAD', scope: 'PERSONAL', createdById: s1.user.id, actions: [{ type: 'UPDATE_FIELD', field: 'status', value: 'NEW' }] })) });
    expect((await newMacro({ name: '第21个' }, s1.token)).json.error.details).toEqual({ name: ['personal_limit_reached'] });
    expect((await newMacro({ name: '乙的第1个' }, s2.token)).status).toBe(201);
    await prisma.macro.createMany({ data: Array.from({ length: MAX_MACROS - MAX_PERSONAL_MACROS - 1 }, (_, i) => ({ organizationId: a.org.id, name: `共享${i}`, entity: 'DEAL', scope: 'SHARED', createdById: mgr.user.id, actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'PROPOSAL' }] })) });
    expect((await newMacro({ name: '第101个', scope: 'SHARED' }, mgr.token)).json.error.details).toEqual({ name: ['limit_reached'] });
  });
});

describe('macros R1 runs', () => {
  it('线索：字段、标签、任务；工作流照常；验证规则与已转化失败；不可见记录；执行次数与审计 / leads', async () => {
    const keep = await newTag('保留');
    const drop = await newTag('移除');
    const m = (
      await newMacro({
        name: '已联系',
        scope: 'SHARED',
        actions: [
          { type: 'UPDATE_FIELD', field: 'status', value: 'CONTACTED' },
          { type: 'ADD_TAG', tagId: keep.id },
          { type: 'REMOVE_TAG', tagId: drop.id },
          { type: 'CREATE_TASK', subject: '回访', dueInDays: 2, assignTo: 'OWNER' },
        ],
      })
    ).json;
    // 工作流：状态变为已联系时通知负责人 / a workflow notifies on the status change
    await call(workflows.POST, { token: a.token, body: { name: '已联系通知', entity: 'LEAD', trigger: 'FIELD_CHANGE', triggerField: 'status', conditions: [{ field: 'status', op: 'EQUALS', value: 'CONTACTED' }], actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '已联系' }] } });
    const l1 = await newLead('线索一', s1.token);
    const l2 = await newLead('线索二', s1.token);
    await prisma.leadTag.create({ data: { organizationId: a.org.id, leadId: l1.id, tagId: drop.id } });
    const other = await newLead('乙的线索', s2.token);
    const res = await run(m.id, [l1.id, l2.id, l1.id, other.id], s1.token);
    expect(res.status).toBe(200);
    expect(res.json.succeeded.sort()).toEqual([l1.id, l2.id].sort());
    expect(res.json.failed).toEqual([{ id: other.id, code: 'NOT_FOUND', message: expect.any(String) }]); // 销售看不到他人线索 / invisible to sales
    for (const l of [l1, l2]) {
      const row = await prisma.lead.findUniqueOrThrow({ where: { id: l.id }, include: { tags: true, activities: true } });
      expect(row.status).toBe('CONTACTED');
      expect(row.tags.map((x) => x.tagId)).toEqual([keep.id]);
      expect(row.activities.map((x) => [x.type, x.subject, x.ownerId])).toEqual([['TASK', '回访', s1.user.id]]);
      expect(Math.round((row.activities[0]!.dueAt!.getTime() - Date.now()) / 86_400_000)).toBe(2);
    }
    expect(await prisma.notification.count({ where: { type: 'WORKFLOW', userId: s1.user.id } })).toBe(2);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('NEW');
    // 执行次数、审计（记录修改以执行人身份）/ run count and audits as the runner
    expect(await prisma.macro.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ runCount: 1, lastRunAt: expect.any(Date) });
    const runLog = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'macro', action: 'macro.run' } })).json.items[0];
    expect(runLog).toMatchObject({ actorId: s1.user.id, changes: { name: '已联系', entity: 'LEAD', succeeded: 2, failed: 1 } });
    const upd = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'lead', action: 'lead.update' } })).json.items as { actorId: string; changes: { fields: { status?: unknown } } }[];
    expect(upd.filter((l) => l.actorId === s1.user.id && l.changes.fields.status)).toHaveLength(2);
    // 验证规则：线索不满足时该条失败，任务不再创建 / a validation rule fails the record and stops its later actions
    await prisma.validationRule.create({ data: { organizationId: a.org.id, name: '已联系须填电话', entity: 'LEAD', when: [{ field: 'status', op: 'EQUALS', value: 'CONTACTED' }], require: [{ field: 'phone', op: 'NOT_EMPTY' }], message: '已联系的线索请填写电话', createdById: a.user.id } });
    const l3 = await newLead('无电话');
    const l4 = (await call(leads.POST, { token: a.token, body: { name: '有电话', phone: '0571-1' } })).json;
    const r2 = await run(m.id, [l3.id, l4.id]);
    expect(r2.json.succeeded).toEqual([l4.id]);
    expect(r2.json.failed).toEqual([{ id: l3.id, code: 'VALIDATION_ERROR', message: expect.any(String) }]);
    expect(await prisma.activity.count({ where: { leadId: l3.id } })).toBe(0);
    // 已转化线索：修改状态被拒 / converted leads refuse status changes
    const l5 = await newLead('已转化');
    expect((await call(convert.POST, { token: a.token, params: { id: l5.id }, body: { account: { mode: 'new' } } })).status).toBe(200);
    expect((await run(m.id, [l5.id])).json.failed[0].id).toBe(l5.id);
    // 不存在的 ID 与超过 100 条 / unknown ids and more than 100
    expect((await run(m.id, [crypto.randomUUID()])).json.failed[0].code).toBe('NOT_FOUND');
    expect((await run(m.id, Array.from({ length: 101 }, () => crypto.randomUUID()))).status).toBe(400);
    expect((await run(crypto.randomUUID(), [l1.id])).status).toBe(404);
  });

  it('商机：阶段历史、指派与通知；指派权限；停用用户与已删标签；他人个人宏 / deals and permissions', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const d = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, amount: '100' } })).json;
    const m = (
      await newMacro(
        { name: '推进并交给甲', entity: 'DEAL', scope: 'SHARED', actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'PROPOSAL' }, { type: 'ASSIGN_OWNER', userId: s1.user.id }, { type: 'CREATE_TASK', subject: '报价', dueInDays: 0, assignTo: 'OWNER' }] },
        mgr.token,
      )
    ).json;
    expect((await run(m.id, [d.id], mgr.token)).json).toEqual({ succeeded: [d.id], failed: [] });
    const row = await prisma.deal.findUniqueOrThrow({ where: { id: d.id }, include: { activities: true } });
    expect(row).toMatchObject({ stage: 'PROPOSAL', ownerId: s1.user.id });
    expect(row.activities.map((x) => x.ownerId)).toEqual([s1.user.id]); // 任务给修改后的负责人 / task goes to the new owner
    expect((await prisma.dealStageHistory.findMany({ where: { dealId: d.id }, orderBy: { changedAt: 'asc' } })).map((h) => h.stage)).toEqual(['QUALIFICATION', 'PROPOSAL']);
    expect(await prisma.notification.count({ where: { userId: s1.user.id, type: 'ASSIGNED', dealId: d.id } })).toBeGreaterThanOrEqual(1);
    // 销售执行含“指派给他人”的共享宏：整体 403 / sales running a macro that assigns to others: 403
    const mine = (await call(deals.POST, { token: s2.token, body: { name: '乙的商机', accountId: (await call(accounts.POST, { token: s2.token, body: { name: '乙客户' } })).json.id, amount: '1' } })).json;
    expect((await run(m.id, [mine.id], s2.token)).json.error.details).toEqual({ actions: ['owner.assign required'] });
    // 停用用户、删除标签后执行 400 / inactive users and deleted tags refuse the run
    await prisma.user.update({ where: { id: s1.user.id }, data: { isActive: false } });
    expect((await run(m.id, [d.id], mgr.token)).json.error.details).toEqual({ actions: ['user_not_found'] });
    const tag = await newTag('临时');
    const tm = (await newMacro({ name: '加临时标签', entity: 'DEAL', actions: [{ type: 'ADD_TAG', tagId: tag.id }] }, s2.token)).json;
    expect((await run(tm.id, [mine.id], s2.token)).json.succeeded).toEqual([mine.id]);
    await prisma.tag.delete({ where: { id: tag.id } });
    expect((await run(tm.id, [mine.id], s2.token)).json.error.details).toEqual({ actions: ['tag_not_found'] });
    // 他人的个人宏不可执行 / others' personal macros cannot run
    expect((await run(tm.id, [mine.id], mgr.token)).status).toBe(404);
    // 只读用户不能执行 / read-only users cannot run
    const ro = await addUser(a.org.id, 'READONLY', '只读');
    const shared2 = (await newMacro({ name: '只读试', entity: 'DEAL', scope: 'SHARED', actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'NEGOTIATION' }] }, mgr.token)).json;
    expect((await run(shared2.id, [d.id], ro.token)).status).toBe(403);
    expect((await newMacro({ name: '只读建' }, ro.token)).status).toBe(403);
  });
});
