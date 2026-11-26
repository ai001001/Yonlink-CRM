/**
 * 标准字段可配置 第一轮：功能测试（默认配置；线索来源与行业新增、改名、排序、停用、删除；状态、阶段、类型只能改名
 * 与停用，顺序固定，锁定选项不能停用；赢单概率；校验与权限、审计；记录写入使用启用的选项、停用的旧值可保留；
 * 新建商机默认阶段；网页表单来源；规则引用自定义选项；导入识别自定义名称；预测与阶段历史使用配置的概率）。
 * Configurable picklists round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountImport from '@/app/api/accounts/import/route';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as stageHistory from '@/app/api/deals/[id]/stage-history/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as forecasts from '@/app/api/forecasts/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as picklistItem from '@/app/api/picklists/[field]/route';
import * as picklists from '@/app/api/picklists/route';
import * as assignment from '@/app/api/assignment-rules/route';
import * as macros from '@/app/api/macros/route';
import * as scoring from '@/app/api/scoring/[entity]/route';
import * as territories from '@/app/api/territories/route';
import * as webForms from '@/app/api/web-forms/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;

type Opt = { value?: string; label?: string | null; isActive: boolean; probability?: number | null };
const put = (field: string, values: Opt[], token = a.token) => call(picklistItem.PUT, { token, params: { field }, body: { values }, method: 'PUT' });
const get = async (token = a.token) => (await call(picklists.GET, { token })).json.fields;
/** 当前配置转为请求体 / current options as a request body */
const asBody = (list: { value: string; label: string | null; isActive: boolean; probability: number | null }[]): Opt[] => list.map((o) => ({ value: o.value, label: o.label, isActive: o.isActive, probability: o.probability }));

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('picklists R1 setup', () => {
  it('默认配置：内置选项、锁定项、默认概率；所有人可读 / defaults, locked options, default probabilities', async () => {
    const f = await get(sales.token);
    expect(f.LEAD_SOURCE.map((o: { value: string }) => o.value)).toEqual(['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER']);
    expect(f.LEAD_STATUS.filter((o: { locked: boolean }) => o.locked).map((o: { value: string }) => o.value)).toEqual(['NEW', 'CONVERTED']);
    expect(f.DEAL_STAGE.map((o: { probability: number | null }) => o.probability)).toEqual([10, 20, 40, 70, null, null]);
    expect(f.ACTIVITY_TYPE).toHaveLength(4);
    expect(f.INDUSTRY.every((o: { isActive: boolean; isCustom: boolean; label: null }) => o.isActive && !o.isCustom && o.label === null)).toBe(true);
  });

  it('线索来源：新增、改名、排序、停用；校验；权限；审计 / lead source: add, rename, reorder, deactivate', async () => {
    const base = asBody((await get()).LEAD_SOURCE);
    const res = await put('LEAD_SOURCE', [{ label: '抖音', isActive: true }, ...base.reverse().map((o) => (o.value === 'COLD_CALL' ? { ...o, isActive: false } : o.value === 'WEBSITE' ? { ...o, label: '官网' } : o))]);
    expect(res.status).toBe(200);
    const list = res.json.items as { value: string; label: string | null; isActive: boolean; isCustom: boolean }[];
    expect(list[0]).toMatchObject({ label: '抖音', isActive: true, isCustom: true });
    expect(list[0]!.value).toMatch(/^C_[0-9A-F]{8}$/);
    expect(list[1]!.value).toBe('OTHER');
    expect(list.find((o) => o.value === 'WEBSITE')!.label).toBe('官网');
    expect(list.find((o) => o.value === 'COLD_CALL')!.isActive).toBe(false);
    expect((await get(sales.token)).LEAD_SOURCE).toEqual(list);
    // 非法请求 / invalid requests
    const bad: [Opt[], string][] = [
      [base.filter((o) => o.value !== 'OTHER'), 'values'],
      [[...base, { label: '无代码', isActive: true }, { label: '无代码', isActive: true }], 'values.8.label'],
      [[...base, { isActive: true }], 'values.7.label'],
      [[...base, { value: 'WEBSITE', isActive: true }], 'values.7.value'],
      [base.map((o) => ({ ...o, isActive: false })), 'values'],
      [base.map((o, i) => (i === 0 ? { ...o, probability: 30 } : o)), 'values.0.probability'],
    ];
    for (const [values, key] of bad) {
      const r = await put('LEAD_SOURCE', values);
      expect(r.status, JSON.stringify(values)).toBe(400);
      expect(Object.keys(r.json.error.details)).toContain(key);
    }
    expect((await put('LEAD_SOURCE', [...base, { value: 'bad-code', isActive: true }])).status).toBe(400);
    expect((await put('SPACE', base)).status).toBe(404);
    for (const u of [mgr, sales]) expect((await put('LEAD_SOURCE', base, u.token)).status).toBe(403);
    const logs = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entityType: 'picklist' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.changes).toMatchObject({ field: 'LEAD_SOURCE', before: expect.any(Array), after: expect.any(Array) });
  });

  it('状态、阶段、类型：只能改名与停用，顺序固定，锁定项不能停用；概率 / fixed lists: rename, deactivate, probability', async () => {
    const stages = asBody((await get()).DEAL_STAGE);
    const ok = await put('DEAL_STAGE', stages.map((o) => (o.value === 'NEEDS_ANALYSIS' ? { ...o, isActive: false, label: '需求调研' } : o.value === 'PROPOSAL' ? { ...o, probability: 55 } : o)));
    expect(ok.status).toBe(200);
    expect(ok.json.items.find((o: { value: string }) => o.value === 'PROPOSAL').probability).toBe(55);
    expect(ok.json.items.find((o: { value: string }) => o.value === 'NEEDS_ANALYSIS')).toMatchObject({ label: '需求调研', isActive: false });
    // 未填概率时用默认 / missing probability falls back to the default
    expect((await put('DEAL_STAGE', stages.map((o) => ({ ...o, probability: null })))).json.items.map((o: { probability: number | null }) => o.probability)).toEqual([10, 20, 40, 70, null, null]);
    const bad: [string, Opt[], string][] = [
      ['DEAL_STAGE', [...stages.slice(1), stages[0]!], 'values'],
      ['DEAL_STAGE', [...stages, { label: '新阶段', isActive: true }], 'values.6.value'],
      ['DEAL_STAGE', stages.map((o) => (o.value === 'CLOSED_WON' ? { ...o, isActive: false } : o)), 'values.4.isActive'],
      ['DEAL_STAGE', stages.map((o) => (o.value === 'CLOSED_LOST' ? { ...o, probability: 5 } : o)), 'values.5.probability'],
      ['DEAL_STAGE', stages.map((o, i) => (i === 0 ? { ...o, probability: 101 } : o)), 'values'],
    ];
    for (const [field, values, key] of bad) {
      const r = await put(field, values);
      expect(r.status, key).toBe(400);
      if (key !== 'values' || r.json.error.details.values) expect(Object.keys(r.json.error.details).some((k) => k.startsWith(key.split('.')[0]!))).toBe(true);
    }
    const statuses = asBody((await get()).LEAD_STATUS);
    expect((await put('LEAD_STATUS', statuses.map((o) => (o.value === 'NEW' ? { ...o, isActive: false } : o)))).json.error.details).toEqual({ 'values.0.isActive': ['locked'] });
    expect((await put('LEAD_STATUS', statuses.map((o) => (o.value === 'CONTACTED' ? { ...o, label: '已联系（电话）' } : o)))).status).toBe(200);
    const types = asBody((await get()).ACTIVITY_TYPE);
    expect((await put('ACTIVITY_TYPE', types.map((o) => (o.value === 'VISIT' ? { ...o, isActive: false } : o)))).status).toBe(200);
  });
});

describe('picklists R1 records', () => {
  it('记录写入：自定义选项可用、停用项不能新选、旧值可保留 / writes use active options; old inactive values stay', async () => {
    const src = (await put('LEAD_SOURCE', [...asBody((await get()).LEAD_SOURCE), { label: '抖音', isActive: true }])).json.items as { value: string; label: string | null }[];
    const douyin = src.find((o) => o.label === '抖音')!.value;
    const lead = await call(leads.POST, { token: sales.token, body: { name: '抖音线索', source: douyin } });
    expect(lead.status).toBe(201);
    expect(lead.json.source).toBe(douyin);
    expect((await call(leads.GET, { token: sales.token, query: { source: douyin } })).json.items).toHaveLength(1);
    expect((await call(leads.POST, { token: sales.token, body: { name: 'x', source: 'C_00000000' } })).json.error.details).toEqual({ source: ['invalid_option'] });
    // 停用 COLD_CALL：新选被拒绝，已有记录可继续编辑 / deactivate COLD_CALL
    const cold = await call(leads.POST, { token: sales.token, body: { name: '电话线索', source: 'COLD_CALL' } });
    await put('LEAD_SOURCE', asBody((await get()).LEAD_SOURCE).map((o) => (o.value === 'COLD_CALL' ? { ...o, isActive: false } : o)));
    expect((await call(leads.POST, { token: sales.token, body: { name: 'y', source: 'COLD_CALL' } })).json.error.details).toEqual({ source: ['inactive_option'] });
    expect((await call(leadItem.PATCH, { token: sales.token, params: { id: lead.json.id }, body: { source: 'COLD_CALL' }, method: 'PATCH' })).json.error.details).toEqual({ source: ['inactive_option'] });
    const keep = await call(leadItem.PATCH, { token: sales.token, params: { id: cold.json.id }, body: { name: '电话线索（改名）', source: 'COLD_CALL' }, method: 'PATCH' });
    expect(keep.status).toBe(200);
    expect(keep.json.source).toBe('COLD_CALL');
    // 状态停用 / an inactive status
    await put('LEAD_STATUS', asBody((await get()).LEAD_STATUS).map((o) => (o.value === 'UNQUALIFIED' ? { ...o, isActive: false } : o)));
    expect((await call(leadItem.PATCH, { token: sales.token, params: { id: cold.json.id }, body: { status: 'UNQUALIFIED' }, method: 'PATCH' })).json.error.details).toEqual({ status: ['inactive_option'] });
    // 自定义选项使用中不能删除，未使用时可删除 / custom options in use cannot be removed
    const withoutDouyin = asBody((await get()).LEAD_SOURCE).filter((o) => o.value !== douyin);
    expect((await put('LEAD_SOURCE', withoutDouyin)).json.error.details).toEqual({ values: [`in_use:${douyin}`] });
    await prisma.lead.update({ where: { id: lead.json.id }, data: { source: null } });
    expect((await put('LEAD_SOURCE', withoutDouyin)).status).toBe(200);
  });

  it('行业、商机阶段、跟进类型 / industry, deal stage, activity type', async () => {
    const ind = (await put('INDUSTRY', [...asBody((await get()).INDUSTRY), { label: '新能源', isActive: true }])).json.items as { value: string; label: string | null }[];
    const ev = ind.find((o) => o.label === '新能源')!.value;
    const acct = await call(accounts.POST, { token: sales.token, body: { name: '新能源客户', industry: ev } });
    expect(acct.json.industry).toBe(ev);
    await put('INDUSTRY', asBody((await get()).INDUSTRY).map((o) => (o.value === ev ? { ...o, isActive: false } : o)));
    expect((await call(accounts.POST, { token: sales.token, body: { name: 'z', industry: ev } })).json.error.details).toEqual({ industry: ['inactive_option'] });
    expect((await call(accountItem.PATCH, { token: sales.token, params: { id: acct.json.id }, body: { name: '改名', industry: ev }, method: 'PATCH' })).status).toBe(200);
    // 阶段：停用“资格确认”后新商机默认第一个启用的进行中阶段 / with QUALIFICATION inactive, new deals start at the first active open stage
    await put('DEAL_STAGE', asBody((await get()).DEAL_STAGE).map((o) => (o.value === 'QUALIFICATION' ? { ...o, isActive: false } : o)));
    const deal = await call(deals.POST, { token: sales.token, body: { name: '商机', accountId: acct.json.id } });
    expect(deal.json.stage).toBe('NEEDS_ANALYSIS');
    expect((await call(deals.POST, { token: sales.token, body: { name: '商机2', accountId: acct.json.id, stage: 'QUALIFICATION' } })).json.error.details).toEqual({ stage: ['inactive_option'] });
    expect((await call(dealItem.PATCH, { token: sales.token, params: { id: deal.json.id }, body: { stage: 'QUALIFICATION' }, method: 'PATCH' })).json.error.details).toEqual({ stage: ['inactive_option'] });
    expect((await call(dealItem.PATCH, { token: sales.token, params: { id: deal.json.id }, body: { stage: 'PROPOSAL' }, method: 'PATCH' })).json.stage).toBe('PROPOSAL');
    // 跟进类型 / activity type
    await put('ACTIVITY_TYPE', asBody((await get()).ACTIVITY_TYPE).map((o) => (o.value === 'VISIT' ? { ...o, isActive: false } : o)));
    expect((await call(activities.POST, { token: sales.token, body: { type: 'VISIT', subject: '拜访' } })).json.error.details).toEqual({ type: ['inactive_option'] });
    expect((await call(activities.POST, { token: sales.token, body: { type: 'CALL', subject: '电话' } })).status).toBe(201);
  });

  it('网页表单、规则、导入引用自定义选项 / web forms, rules and imports use custom options', async () => {
    const src = (await put('LEAD_SOURCE', [...asBody((await get()).LEAD_SOURCE), { label: '小红书', isActive: true }, { label: '已停用渠道', isActive: false }])).json.items as { value: string; label: string | null }[];
    const xhs = src.find((o) => o.label === '小红书')!.value;
    const off = src.find((o) => o.label === '已停用渠道')!.value;
    const form = await call(webForms.POST, { token: a.token, body: { name: '表单', title: '联系我们', source: xhs } });
    expect(form.status).toBe(201);
    expect((await call(webForms.POST, { token: a.token, body: { name: '表单2', title: '联系我们', source: off } })).json.error.details).toEqual({ source: ['inactive_option'] });
    // 工作流条件与动作可引用自定义代码 / workflows may reference custom codes
    const wf = await call(workflows.POST, {
      token: a.token,
      body: { name: '小红书线索', entity: 'LEAD', trigger: 'CREATE', conditions: [{ field: 'source', op: 'EQUALS', value: 'ADVERTISEMENT' }], actions: [{ type: 'UPDATE_FIELD', field: 'source', value: xhs }] },
    });
    expect(wf.status).toBe(201);
    expect((await call(workflows.POST, { token: a.token, body: { name: '坏', entity: 'LEAD', trigger: 'CREATE', conditions: [{ field: 'source', op: 'EQUALS', value: 'bad value' }], actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] } })).status).toBe(400);
    // 规则中引用的选项须为本组织的选项（停用的也可引用）；不存在的被拒绝 / rules may reference the organization's options (inactive too); unknown ones are refused
    expect((await call(assignment.PUT, { token: a.token, body: { rules: [{ name: '小红书', userIds: [sales.user.id], conditions: [{ field: 'source', op: 'EQUALS', value: xhs }] }] }, method: 'PUT' })).status).toBe(200);
    expect((await call(assignment.PUT, { token: a.token, body: { rules: [{ name: '停用', userIds: [sales.user.id], conditions: [{ field: 'source', op: 'EQUALS', value: off }] }] }, method: 'PUT' })).status).toBe(200);
    expect((await call(assignment.PUT, { token: a.token, body: { rules: [{ name: '不存在', userIds: [sales.user.id], conditions: [{ field: 'source', op: 'EQUALS', value: 'C_00000000' }] }] }, method: 'PUT' })).json.error.details).toEqual({ 'rules.0.conditions.0.value': ['invalid_option'] });
    const lead = { kind: 'FIELD_EQUALS', field: 'source', points: 10, isActive: true };
    expect((await call(scoring.PUT, { token: a.token, params: { entity: 'lead' }, body: { hotScore: 40, warmScore: 20, rules: [{ ...lead, value: xhs }] }, method: 'PUT' })).status).toBe(200);
    expect((await call(scoring.PUT, { token: a.token, params: { entity: 'lead' }, body: { hotScore: 40, warmScore: 20, rules: [{ ...lead, value: 'C_00000000' }] }, method: 'PUT' })).status).toBe(400);
    expect((await call(workflows.POST, { token: a.token, body: { name: '不存在', entity: 'LEAD', trigger: 'CREATE', conditions: [{ field: 'source', op: 'EQUALS', value: 'C_00000000' }], actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: 'x' }] } })).json.error.details).toEqual({ 'conditions.0.value': ['invalid_option'] });
    expect((await call(macros.POST, { token: a.token, body: { name: '标为小红书', entity: 'LEAD', actions: [{ type: 'UPDATE_FIELD', field: 'source', value: xhs }] } })).status).toBe(201);
    expect((await call(macros.POST, { token: a.token, body: { name: '坏宏', entity: 'LEAD', actions: [{ type: 'UPDATE_FIELD', field: 'source', value: 'C_00000000' }] } })).status).toBe(400);
    // 评分规则中的自定义选项会命中 / scoring rules match custom options
    const scored = await call(leads.POST, { token: sales.token, body: { name: '小红书线索', source: xhs } });
    expect(scored.json.score).toBe(10);
    // 工作流把广告来源改为自定义选项 / the workflow sets a custom option
    const ad = await call(leads.POST, { token: sales.token, body: { name: '广告线索', source: 'ADVERTISEMENT' } });
    expect(ad.json).toMatchObject({ source: xhs, score: 10 });
    // 导入：自定义名称、改名后的名称、停用项 / imports: custom labels, renamed labels, inactive options
    const ind = (await put('INDUSTRY', [...asBody((await get()).INDUSTRY).map((o) => (o.value === 'IT' ? { ...o, label: '互联网' } : o)), { label: '新能源', isActive: true }])).json.items as { value: string; label: string | null }[];
    // 区域规则可用自定义行业 / territory rules may use custom industries
    const ev = ind.find((o) => o.label === '新能源')!.value;
    expect((await call(territories.POST, { token: a.token, body: { name: '新能源区', conditions: [{ field: 'industry', op: 'EQUALS', value: ev }] } })).status).toBe(201);
    expect((await call(territories.POST, { token: a.token, body: { name: '不存在区', conditions: [{ field: 'industry', op: 'EQUALS', value: 'C_00000000' }] } })).status).toBe(400);
    const csv = '客户名称,行业\n甲,新能源\n乙,互联网\n丙,制造业\n丁,不存在的行业\n';
    const rep = (await call(accountImport.POST, { token: a.token, body: { csv, dryRun: false } })).json;
    expect(rep.created).toBe(3);
    expect(rep.errors).toEqual([expect.objectContaining({ row: 5, field: 'industry' })]);
    const rows = await prisma.account.findMany({ where: { organizationId: a.org.id }, orderBy: { name: 'asc' } });
    expect(rows.map((r) => [r.name, r.industry])).toEqual([
      ['丁', null],
      ['丙', 'MANUFACTURING'],
      ['乙', 'IT'],
      ['甲', expect.stringMatching(/^C_/)],
    ].filter((r) => r[0] !== '丁'));
  });

  it('预测与阶段历史使用配置的概率 / forecasts and stage history use configured probabilities', async () => {
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const month = new Date().toISOString().slice(0, 7);
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acct.id, stage: 'PROPOSAL', amount: '1000', expectedCloseDate: `${month}-15` } })).json;
    expect((await call(forecasts.GET, { token: a.token, query: { period: month } })).json.totals.weighted).toBe('400.00');
    await put('DEAL_STAGE', asBody((await get()).DEAL_STAGE).map((o) => (o.value === 'PROPOSAL' ? { ...o, probability: 55 } : o)));
    const fc = (await call(forecasts.GET, { token: a.token, query: { period: month } })).json;
    expect(fc.totals.weighted).toBe('550.00');
    expect(fc.probabilities.PROPOSAL).toBe(55);
    const hist = (await call(stageHistory.GET, { token: a.token, params: { id: deal.id } })).json.items;
    expect(hist[hist.length - 1] ?? hist[0]).toMatchObject({ probability: 55, expectedRevenue: '550.00' });
  });
});
