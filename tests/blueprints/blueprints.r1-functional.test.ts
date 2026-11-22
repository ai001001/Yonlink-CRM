/**
 * 流程蓝图 第一轮：功能测试（维护：校验、同名、上限、每个对象只能启用一个、对象不可改、转换 ID 保留、删除、权限、审计；
 * 强制：编辑、批量、宏、工作流、查重合并不能直接改受控字段，新建与线索转化不受影响，停用后恢复；
 * 转换：可用转换按状态、角色、可编辑过滤，必填字段与备注、只能提交转换字段、角色、状态、验证规则与工作流照常、审计）。
 * Blueprints round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as bpItem from '@/app/api/blueprints/[id]/route';
import * as bpStatus from '@/app/api/blueprints/status/route';
import * as bpTransitions from '@/app/api/blueprints/transitions/route';
import * as blueprints from '@/app/api/blueprints/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as merge from '@/app/api/duplicates/merge/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as macroRun from '@/app/api/macros/[id]/run/route';
import * as macros from '@/app/api/macros/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { MAX_BLUEPRINTS } from '@/server/modules/blueprints';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;
const ALL = ['ADMIN', 'MANAGER', 'SALES'];
const DEAL_TRANSITIONS = [
  { name: '需求分析', from: ['QUALIFICATION'], to: 'NEEDS_ANALYSIS', roles: ALL, fields: ['expectedCloseDate'] },
  { name: '提交方案', from: ['NEEDS_ANALYSIS'], to: 'PROPOSAL', roles: ALL, fields: ['amount'] },
  { name: '赢单', from: ['PROPOSAL'], to: 'CLOSED_WON', roles: ['ADMIN', 'MANAGER'], noteRequired: true },
  { name: '输单', from: ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL'], to: 'CLOSED_LOST', roles: ALL, noteRequired: true },
];
const newBp = (body: object, token = a.token) => call(blueprints.POST, { token, body: { name: '流程', entity: 'DEAL', transitions: DEAL_TRANSITIONS, ...body } });
const patchBp = (id: string, body: object, token = a.token) => call(bpItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const available = (entity: string, id: string, token = a.token) => call(bpTransitions.GET, { token, query: { entity, id } });
const runTr = (body: object, token = a.token) => call(bpTransitions.POST, { token, body: { entity: 'DEAL', ...body } });
const trId = async (name: string, entity = 'DEAL') => ((await prisma.blueprint.findFirstOrThrow({ where: { organizationId: a.org.id, entity: entity as 'DEAL', isActive: true } })).transitions as { id: string; name: string }[]).find((x) => x.name === name)!.id;
let acc: { id: string };
const newDeal = async (body: object = {}, token = a.token) => (await call(deals.POST, { token, body: { name: '商机', accountId: acc.id, amount: '0', ...body } })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', ownerId: sales.user.id } })).json;
});

describe('blueprints R1 maintenance', () => {
  it('校验、同名、启用唯一、对象不可改、转换 ID 保留、删除、权限、审计 / maintenance', async () => {
    const r = await newBp({ isActive: true });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '流程', entity: 'DEAL', isActive: true, createdBy: { id: a.user.id } });
    expect(r.json.transitions).toHaveLength(4);
    expect(r.json.transitions.every((tr: { id: string; fields: string[]; noteRequired: boolean }) => /^[0-9a-f-]{36}$/.test(tr.id) && Array.isArray(tr.fields) && typeof tr.noteRequired === 'boolean')).toBe(true);
    const one = (x: object) => [{ name: '转换', from: ['QUALIFICATION'], to: 'PROPOSAL', roles: ALL, ...x }];
    const bad: object[] = [
      { name: ' ' },
      { transitions: [] },
      { transitions: Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, from: ['QUALIFICATION'], to: 'PROPOSAL', roles: ALL })) },
      { transitions: one({ to: 'WON' }) },
      { transitions: one({ from: ['NEW'] }) },
      { transitions: one({ from: ['PROPOSAL'] }) },
      { transitions: one({ from: [] }) },
      { transitions: [...one({}), ...one({ name: ' 转换 ' }).map((x) => ({ ...x, to: 'NEGOTIATION' }))] },
      { transitions: [...one({}), ...one({ name: '另一个' })] },
      { transitions: one({ fields: ['phone'] }) },
      { transitions: one({ roles: ['READONLY'] }) },
      { transitions: one({ roles: [] }) },
      { transitions: one({ roles: ['SALES', 'SALES'] }) },
      { entity: 'ACCOUNT' },
      { entity: 'LEAD', transitions: one({ to: 'CONTACTED', from: ['NEW'], fields: ['amount'] }) },
      { entity: 'LEAD', transitions: one({ to: 'CONVERTED', from: ['NEW'] }) },
    ];
    for (const [i, body] of bad.entries()) expect((await newBp({ name: `非法${i}`, ...body })).status, JSON.stringify(body)).toBe(400);
    expect((await newBp({ name: ' 流程 ' })).json.error.details).toEqual({ name: ['taken'] });
    // 每个对象只能启用一个；线索可以另启用 / one active per entity
    expect((await newBp({ name: '第二个', isActive: true })).json.error.details).toEqual({ isActive: ['another_active'] });
    const second = (await newBp({ name: '第二个' }, mgr.token)).json;
    expect((await patchBp(second.id, { isActive: true })).json.error.details).toEqual({ isActive: ['another_active'] });
    const lead = await newBp({ name: '线索流程', entity: 'LEAD', isActive: true, transitions: [{ name: '已联系', from: ['NEW'], to: 'CONTACTED', roles: ALL, fields: ['company'] }] });
    expect(lead.status).toBe(201);
    // 权限：销售不能维护与查看列表，但可读取状态 / sales cannot maintain or list, but can read the status
    expect((await newBp({ name: '销售建' }, sales.token)).status).toBe(403);
    expect((await call(blueprints.GET, { token: sales.token })).status).toBe(403);
    expect((await call(bpStatus.GET, { token: sales.token, query: { entity: 'DEAL' } })).json).toEqual({ active: { id: r.json.id, name: '流程' }, field: 'stage' });
    // 修改：对象不可改；改转换需提交对象；已有转换的 ID 保留 / update rules
    expect((await patchBp(r.json.id, { entity: 'LEAD', transitions: DEAL_TRANSITIONS })).status).toBe(400);
    expect((await patchBp(r.json.id, { transitions: DEAL_TRANSITIONS })).json.error.details).toEqual({ entity: ['required'] });
    const kept = r.json.transitions[0];
    const u = await patchBp(r.json.id, { name: '流程2', entity: 'DEAL', transitions: [kept, { name: '新转换', from: ['NEGOTIATION'], to: 'CLOSED_WON', roles: ['ADMIN'] }] }, mgr.token);
    expect(u.json.transitions[0].id).toBe(kept.id);
    expect(u.json.transitions[1].id).not.toBe(kept.id);
    // 停用后另一个可启用；删除 / switch the active one; delete
    expect((await patchBp(r.json.id, { isActive: false })).json.isActive).toBe(false);
    expect((await patchBp(second.id, { isActive: true })).json.isActive).toBe(true);
    expect((await call(bpItem.DELETE, { token: a.token, params: { id: second.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(bpStatus.GET, { token: a.token, query: { entity: 'DEAL' } })).json.active).toBeNull();
    const b = await createTenant('B');
    expect((await patchBp(r.json.id, { isActive: true }, b.token)).status).toBe(404);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'blueprint' } })).json.items as { action: string }[];
    expect(logs.map((l) => l.action).sort()).toEqual(['blueprint.create', 'blueprint.create', 'blueprint.create', 'blueprint.delete', 'blueprint.update', 'blueprint.update', 'blueprint.update']);
    // 上限 / limit
    await prisma.blueprint.createMany({ data: Array.from({ length: MAX_BLUEPRINTS - 2 }, (_, i) => ({ organizationId: a.org.id, name: `批量${i}`, entity: 'DEAL', transitions: DEAL_TRANSITIONS, createdById: a.user.id })) });
    expect((await newBp({ name: '第21个' })).json.error.details).toEqual({ name: ['limit_reached'] });
  });
});

describe('blueprints R1 enforcement', () => {
  it('启用后编辑、批量、宏、工作流、合并不能直接改受控字段；新建与转化不受影响；停用后恢复 / enforcement', async () => {
    const bp = (await newBp({ isActive: true })).json;
    const d = await newDeal({ stage: 'PROPOSAL' }); // 新建可以任意阶段 / creating is free
    expect(d.stage).toBe('PROPOSAL');
    const edit = await call(dealItem.PATCH, { token: a.token, params: { id: d.id }, body: { stage: 'NEGOTIATION' }, method: 'PATCH' });
    expect(edit.status).toBe(409);
    expect(edit.json.error).toMatchObject({ code: 'BLUEPRINT_CONTROLLED', details: { stage: ['blueprint'] } });
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: d.id }, body: { stage: 'PROPOSAL', name: '改名' }, method: 'PATCH' })).json.name).toBe('改名');
    expect((await call(dealBulk.POST, { token: a.token, body: { action: 'stage', ids: [d.id], stage: 'NEGOTIATION' } })).json.failed[0].code).toBe('BLUEPRINT_CONTROLLED');
    const m = (await call(macros.POST, { token: a.token, body: { name: '推进', entity: 'DEAL', actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'NEGOTIATION' }] } })).json;
    expect((await call(macroRun.POST, { token: a.token, params: { id: m.id }, body: { ids: [d.id] } })).json.failed[0].code).toBe('BLUEPRINT_CONTROLLED');
    await call(workflows.POST, { token: a.token, body: { name: '改名即推进', entity: 'DEAL', trigger: 'UPDATE', actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'NEGOTIATION' }] } });
    await call(dealItem.PATCH, { token: a.token, params: { id: d.id }, body: { name: '再改名' }, method: 'PATCH' });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).stage).toBe('PROPOSAL');
    const run = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'workflow', action: 'workflow.run' } })).json.items[0];
    expect(run.changes.skipped).toEqual(['UPDATE_FIELD stage: blueprint']);
    // 停用后恢复 / deactivating frees the field
    await patchBp(bp.id, { isActive: false });
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: d.id }, body: { stage: 'NEGOTIATION' }, method: 'PATCH' })).json.stage).toBe('NEGOTIATION');
  });

  it('线索蓝图：编辑被拒；转化照常；查重合并不能改状态 / lead blueprint', async () => {
    await newBp({ name: '线索流程', entity: 'LEAD', isActive: true, transitions: [{ name: '已联系', from: ['NEW'], to: 'CONTACTED', roles: ALL }] });
    const l1 = (await call(leads.POST, { token: a.token, body: { name: '张三', email: 'z@example.com' } })).json;
    const l2 = (await call(leads.POST, { token: a.token, body: { name: '张三', email: 'z@example.com', status: 'QUALIFIED' } })).json;
    expect(l2.status).toBe('QUALIFIED');
    expect((await call(leadItem.PATCH, { token: a.token, params: { id: l1.id }, body: { status: 'QUALIFIED' }, method: 'PATCH' })).json.error.code).toBe('BLUEPRINT_CONTROLLED');
    expect((await call(merge.POST, { token: a.token, body: { entity: 'leads', masterId: l1.id, duplicateIds: [l2.id], fields: { status: l2.id } } })).json.error.code).toBe('BLUEPRINT_CONTROLLED');
    expect((await call(merge.POST, { token: a.token, body: { entity: 'leads', masterId: l1.id, duplicateIds: [l2.id] } })).status).toBe(200);
    expect((await call(convert.POST, { token: a.token, params: { id: l1.id }, body: { account: { mode: 'new' } } })).status).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l1.id } })).status).toBe('CONVERTED');
    expect((await available('LEAD', l1.id)).json.transitions).toEqual([]); // 已转化没有可执行转换 / none after conversion
  });
});

describe('blueprints R1 transitions', () => {
  it('可用转换、必填字段与备注、只能提交转换字段、角色、状态、验证规则与工作流、审计 / running transitions', async () => {
    await newBp({ isActive: true });
    const d = await newDeal({ ownerId: sales.user.id });
    // 可用转换：按当前状态与角色 / available by state and role
    const av = await available('DEAL', d.id, sales.token);
    expect(av.json).toMatchObject({ blueprint: { name: '流程' }, state: 'QUALIFICATION' });
    expect(av.json.transitions.map((x: { name: string }) => x.name).sort()).toEqual(['输单', '需求分析']);
    const ro = await addUser(a.org.id, 'READONLY', '只读');
    expect((await available('DEAL', d.id, ro.token)).json.transitions).toEqual([]);
    const other = await addUser(a.org.id, 'SALES', '他人');
    expect((await available('DEAL', d.id, other.token)).status).toBe(404);
    // 必填字段为空 400；提交非转换字段 400；成功后阶段与历史 / required fields, extra fields, success
    const analyse = await trId('需求分析');
    expect((await runTr({ id: d.id, transitionId: analyse }, sales.token)).json.error.details).toEqual({ 'fields.expectedCloseDate': ['required'] });
    expect((await runTr({ id: d.id, transitionId: analyse, fields: { expectedCloseDate: '2027-01-15', amount: '5' } }, sales.token)).json.error.details).toEqual({ 'fields.amount': ['not_allowed'] });
    expect((await runTr({ id: d.id, transitionId: analyse, fields: { expectedCloseDate: '2027-02-30' } }, sales.token)).status).toBe(400);
    const ok = await runTr({ id: d.id, transitionId: analyse, fields: { expectedCloseDate: '2027-01-15' } }, sales.token);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ stage: 'NEEDS_ANALYSIS', expectedCloseDate: expect.stringMatching(/^2027-01-15/) });
    expect((await prisma.dealStageHistory.findMany({ where: { dealId: d.id }, orderBy: { changedAt: 'asc' } })).map((h) => h.stage)).toEqual(['QUALIFICATION', 'NEEDS_ANALYSIS']);
    // 再次执行同一转换：状态已不是出发状态 409 / the same transition again: 409
    expect((await runTr({ id: d.id, transitionId: analyse, fields: { expectedCloseDate: '2027-01-16' } }, sales.token)).json.error.details).toEqual({ transitionId: ['not_available'] });
    // 金额为 0 视为未填；工作流照常触发 / zero amount is empty; workflows still fire
    await call(workflows.POST, { token: a.token, body: { name: '方案通知', entity: 'DEAL', trigger: 'FIELD_CHANGE', triggerField: 'stage', conditions: [{ field: 'stage', op: 'EQUALS', value: 'PROPOSAL' }], actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '已提交方案' }] } });
    const propose = await trId('提交方案');
    expect((await runTr({ id: d.id, transitionId: propose }, sales.token)).json.error.details).toEqual({ 'fields.amount': ['required'] });
    expect((await runTr({ id: d.id, transitionId: propose, fields: { amount: '0' } }, sales.token)).json.error.details).toEqual({ 'fields.amount': ['required'] });
    expect((await runTr({ id: d.id, transitionId: propose, fields: { amount: '88000.50' } }, sales.token)).json).toMatchObject({ stage: 'PROPOSAL', amount: '88000.5' });
    expect(await prisma.notification.count({ where: { type: 'WORKFLOW', dealId: d.id } })).toBe(1);
    // 角色不允许 403；备注必填；备注写入 / roles and notes
    const win = await trId('赢单');
    expect((await runTr({ id: d.id, transitionId: win, note: '签约' }, sales.token)).status).toBe(403);
    expect((await runTr({ id: d.id, transitionId: win }, mgr.token)).json.error.details).toEqual({ note: ['required'] });
    // 验证规则照常：赢单须填描述 / validation rules still apply
    await prisma.validationRule.create({ data: { organizationId: a.org.id, name: '赢单须填描述', entity: 'DEAL', when: [{ field: 'stage', op: 'EQUALS', value: 'CLOSED_WON' }], require: [{ field: 'description', op: 'NOT_EMPTY' }], message: '赢单请填写描述', createdById: a.user.id } });
    expect((await runTr({ id: d.id, transitionId: win, note: '签约' }, mgr.token)).json.error.code).toBe('VALIDATION_ERROR');
    await prisma.validationRule.deleteMany();
    expect((await runTr({ id: d.id, transitionId: win, note: '  客户已签约  ' }, mgr.token)).json.stage).toBe('CLOSED_WON');
    expect((await prisma.note.findMany({ where: { dealId: d.id } })).map((n) => n.content)).toEqual(['客户已签约']);
    // 审计 / audit
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'deal', action: 'deal.transition' } })).json.items as { actorId: string; changes: object }[];
    expect(logs.map((l) => l.changes)).toEqual([
      { blueprint: '流程', transition: '赢单', from: 'PROPOSAL', to: 'CLOSED_WON', note: true },
      { blueprint: '流程', transition: '提交方案', from: 'NEEDS_ANALYSIS', to: 'PROPOSAL' },
      { blueprint: '流程', transition: '需求分析', from: 'QUALIFICATION', to: 'NEEDS_ANALYSIS' },
    ]);
    // 未知转换、没有启用的蓝图 / unknown transition and no active blueprint
    expect((await runTr({ id: d.id, transitionId: crypto.randomUUID() })).json.error.details).toEqual({ transitionId: ['not_found'] });
    await prisma.blueprint.updateMany({ data: { isActive: false } });
    expect((await runTr({ id: d.id, transitionId: win, note: 'x' })).json.error.details).toEqual({ transitionId: ['no_blueprint'] });
    expect((await available('DEAL', d.id)).json).toEqual({ blueprint: null, state: 'CLOSED_WON', transitions: [] });
  });

  it('线索转换：必填公司；已有值时可不提交 / lead transition with an existing value', async () => {
    await newBp({ name: '线索流程', entity: 'LEAD', isActive: true, transitions: [{ name: '已联系', from: ['NEW'], to: 'CONTACTED', roles: ALL, fields: ['company', 'email'] }] });
    const l = (await call(leads.POST, { token: sales.token, body: { name: '李四', company: '远望' } })).json;
    const id = await trId('已联系', 'LEAD');
    expect((await runTr({ entity: 'LEAD', id: l.id, transitionId: id }, sales.token)).json.error.details).toEqual({ 'fields.email': ['required'] });
    expect((await runTr({ entity: 'LEAD', id: l.id, transitionId: id, fields: { email: 'bad' } }, sales.token)).status).toBe(400);
    const r = await runTr({ entity: 'LEAD', id: l.id, transitionId: id, fields: { email: 'li@example.com' } }, sales.token);
    expect(r.json).toMatchObject({ status: 'CONTACTED', company: '远望', email: 'li@example.com' });
  });
});
