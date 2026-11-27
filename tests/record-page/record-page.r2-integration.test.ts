/**
 * 整页详情 第二轮：集成测试（自定义字段的单项修改只改该项；流程蓝图启用时直接改阶段被拒；线索转化写入时间线；
 * 删除备注后时间线同步；跟进改派后原查看者看不到；工作流的系统修改出现在时间线；API 密钥按其用户）。
 * Full-page detail round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as activityItem from '@/app/api/activities/[id]/route';
import * as activities from '@/app/api/activities/route';
import * as blueprints from '@/app/api/blueprints/route';
import * as fields from '@/app/api/custom-fields/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import * as noteItem from '@/app/api/notes/[id]/route';
import * as notes from '@/app/api/notes/route';
import * as timeline from '@/app/api/timeline/route';
import * as workflows from '@/app/api/workflows/route';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
type Item = { kind: string; id: string; entry?: { action: string; actor: { id: string } | null } };
const items = async (entity: string, id: string, token = a.token) => (await call(timeline.GET, { token, query: { entity, id } })).json.items as Item[];

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('record page R2', () => {
  it('自定义字段单项修改；蓝图控制的阶段 / single custom field edit; blueprint-controlled stage', async () => {
    const f1 = (await call(fields.POST, { token: a.token, body: { entity: 'DEAL', label: '合同编号', type: 'TEXT' } })).json;
    const f2 = (await call(fields.POST, { token: a.token, body: { entity: 'DEAL', label: '已签约', type: 'CHECKBOX' } })).json;
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acct.id, custom: { [f1.key]: 'HT-001', [f2.key]: false } } })).json;
    const r = await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { custom: { [f2.key]: true } }, method: 'PATCH' });
    expect(r.json.custom).toEqual({ [f1.key]: 'HT-001', [f2.key]: true });
    // 启用蓝图（新建时默认停用，需显式启用）后不能直接改阶段 / with an active blueprint (created inactive by default) the stage cannot change directly
    await call(blueprints.POST, { token: a.token, body: { name: '流程', entity: 'DEAL', isActive: true, transitions: [{ name: '需求分析', from: ['QUALIFICATION'], to: 'NEEDS_ANALYSIS', roles: ['ADMIN', 'MANAGER', 'SALES'] }] } });
    const stage = await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { stage: 'PROPOSAL' }, method: 'PATCH' });
    expect(stage.status).toBe(409);
    expect(stage.json.error.code).toBe('BLUEPRINT_CONTROLLED');
    // 其他字段仍可单独修改 / other fields still change one by one
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { name: '改名' }, method: 'PATCH' })).status).toBe(200);
  });

  it('线索转化、删除备注、跟进改派、工作流修改 / conversion, note deletion, reassignment, workflow changes', async () => {
    const sales = await addUser(a.org.id, 'SALES', '销售');
    const lead = (await call(leads.POST, { token: sales.token, body: { name: '转化线索', company: '甲公司' } })).json;
    const note = (await call(notes.POST, { token: sales.token, body: { leadId: lead.id, content: '待删除的备注' } })).json;
    const act = (await call(activities.POST, { token: sales.token, body: { type: 'CALL', subject: '电话', leadId: lead.id } })).json;
    expect((await items('lead', lead.id, sales.token)).map((x) => x.kind).sort()).toEqual(['activity', 'audit', 'note']);
    await call(noteItem.DELETE, { token: sales.token, params: { id: note.id }, method: 'DELETE' });
    expect((await items('lead', lead.id, sales.token)).some((x) => x.kind === 'note')).toBe(false);
    // 改派给他人后，销售在时间线中看不到该跟进 / after reassignment the activity leaves the sales rep's timeline
    await call(activityItem.PATCH, { token: a.token, params: { id: act.id }, body: { ownerId: a.user.id }, method: 'PATCH' });
    expect((await items('lead', lead.id, sales.token)).some((x) => x.kind === 'activity')).toBe(false);
    expect((await items('lead', lead.id)).some((x) => x.kind === 'activity')).toBe(true);
    await call(convert.POST, { token: sales.token, params: { id: lead.id }, body: { account: { mode: 'new' } } });
    expect((await items('lead', lead.id, sales.token)).map((x) => x.entry?.action).filter(Boolean)).toContain('lead.convert');
    // 工作流做出的修改出现在商机时间线 / workflow changes show on the deal timeline
    await call(workflows.POST, { token: a.token, body: { name: '新商机通知', entity: 'DEAL', trigger: 'CREATE', conditions: [], actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'NEEDS_ANALYSIS' }] } });
    const acct = (await call(accounts.POST, { token: sales.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: sales.token, body: { name: '商机', accountId: acct.id } })).json;
    expect(deal.stage).toBe('NEEDS_ANALYSIS');
    // 工作流的执行记录在工作流名下；商机上记录的是它做出的字段修改 / the run is audited on the workflow; the deal records the field change
    const changes = (await items('deal', deal.id, sales.token)).filter((x) => x.kind === 'audit');
    expect(changes.map((x) => x.entry!.action)).toEqual(['deal.update', 'deal.create']);
  });

  it('API 密钥按其用户 / API keys act as their user', async () => {
    const sales = await addUser(a.org.id, 'SALES', '销售');
    const keys = await import('@/app/api/api-keys/route');
    const key = (await call(keys.POST, { token: a.token, body: { name: '销售密钥', userId: sales.user.id } })).json.key;
    const mine = (await call(leads.POST, { token: sales.token, body: { name: '销售的线索' } })).json;
    const admins = (await call(leads.POST, { token: a.token, body: { name: '管理员的线索' } })).json;
    expect((await call(timeline.GET, { token: key, query: { entity: 'lead', id: mine.id } })).status).toBe(200);
    expect((await call(timeline.GET, { token: key, query: { entity: 'lead', id: admins.id } })).status).toBe(404);
  });
});
