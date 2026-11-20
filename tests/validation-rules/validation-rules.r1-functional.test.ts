/**
 * 字段验证规则 第一轮：功能测试（日期条件判断；规则维护：新建、按对象校验字段与比较方式、日期格式、提示字段、同名、只启停、
 * 整体修改、对象不可改、删除、权限、上限、审计；执行：商机新建/编辑按写入后的值校验、多条规则同时失败全部列出并按字段归类、
 * 停用规则不生效、批量改阶段逐条失败、线索规则；不校验：网页表单、导入、工作流改动）。
 * Validation rules round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as dealBulk from '@/app/api/deals/bulk/route';
import * as deals from '@/app/api/deals/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leads from '@/app/api/leads/route';
import * as publicForm from '@/app/api/public/web-forms/[key]/route';
import * as ruleItem from '@/app/api/validation-rules/[id]/route';
import * as rules from '@/app/api/validation-rules/route';
import * as forms from '@/app/api/web-forms/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { resetWebFormLimiter } from '@/server/modules/web-forms';
import { evaluate } from '@/server/modules/workflows';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let acc: { id: string };

const create = (body: object, token = a.token) =>
  call(rules.POST, { token, body: { name: '规则', entity: 'DEAL', require: [{ field: 'expectedCloseDate', op: 'NOT_EMPTY' }], message: '请填写预计成交日', ...body } });
const patchRule = (id: string, body: object, token = a.token) => call(ruleItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const newDeal = (body: object = {}) => call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, ...body } });
const bigDealRule = () => create({ name: '大额', when: [{ field: 'amount', op: 'GTE', value: '1000000' }], errorField: 'expectedCloseDate', message: '大额商机须填预计成交日' });
const lostRule = () => create({ name: '输单原因', when: [{ field: 'stage', op: 'EQUALS', value: 'CLOSED_LOST' }], require: [{ field: 'description', op: 'NOT_EMPTY' }], errorField: 'description', message: '请填写输单原因' });

beforeEach(async () => {
  await resetDb();
  resetWebFormLimiter();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
});

describe('validation rules R1 conditions', () => {
  it('日期条件：为空、不为空、≥、≤（按日期部分比较）/ date conditions', () => {
    const def = { type: 'date' as const };
    const d = new Date('2026-12-31T00:00:00Z');
    expect(evaluate(def, { field: 'x', op: 'IS_EMPTY' }, null)).toBe(true);
    expect(evaluate(def, { field: 'x', op: 'NOT_EMPTY' }, d)).toBe(true);
    expect(evaluate(def, { field: 'x', op: 'GTE', value: '2026-12-31' }, d)).toBe(true);
    expect(evaluate(def, { field: 'x', op: 'GTE', value: '2027-01-01' }, d)).toBe(false);
    expect(evaluate(def, { field: 'x', op: 'LTE', value: '2026-12-31' }, '2026-12-31')).toBe(true);
    expect(evaluate(def, { field: 'x', op: 'LTE', value: '2026-12-31' }, null)).toBe(false);
  });
});

describe('validation rules R1 maintenance', () => {
  it('新建、校验、同名、启停、修改、删除、权限、审计 / maintenance', async () => {
    const r = await bigDealRule();
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '大额', entity: 'DEAL', isActive: true, errorField: 'expectedCloseDate', when: [{ field: 'amount', op: 'GTE', value: '1000000' }] });
    expect((await bigDealRule()).json.error.details).toEqual({ name: ['taken'] });
    const bad: object[] = [
      { require: [] },
      { require: [{ field: 'score', op: 'GTE', value: '1' }] },
      { entity: 'LEAD', require: [{ field: 'expectedCloseDate', op: 'NOT_EMPTY' }] },
      { require: [{ field: 'expectedCloseDate', op: 'CONTAINS', value: 'x' }] },
      { require: [{ field: 'expectedCloseDate', op: 'GTE', value: '2026/12/31' }] },
      { when: Array.from({ length: 6 }, () => ({ field: 'name', op: 'CONTAINS', value: 'a' })) },
      { errorField: 'mobile' },
      { message: ' ' },
      { entity: 'ACCOUNT' },
      { extra: 1 },
    ];
    for (const [i, body] of bad.entries()) expect((await create({ name: `非法${i}`, ...body })).status, JSON.stringify(body)).toBe(400);
    expect((await create({ name: '线索手机', entity: 'LEAD', require: [{ field: 'mobile', op: 'NOT_EMPTY' }], errorField: 'mobile' })).status).toBe(201);
    // 启停、修改、对象不可改 / toggle, update, immutable entity
    const id = r.json.id;
    expect((await patchRule(id, { isActive: false })).json.isActive).toBe(false);
    expect((await patchRule(id, { name: '只改名' })).status).toBe(400);
    expect((await patchRule(id, { name: '大额 2', entity: 'DEAL', require: [{ field: 'description', op: 'NOT_EMPTY' }], message: '请写描述', errorField: null })).json).toMatchObject({ name: '大额 2', errorField: null });
    expect((await patchRule(id, { name: 'x', entity: 'LEAD', require: [{ field: 'name', op: 'NOT_EMPTY' }], message: 'x' })).json.error.details).toEqual({ entity: ['immutable'] });
    // 权限 / permissions
    expect((await create({ name: '销售建' }, rep.token)).status).toBe(403);
    expect((await call(rules.GET, { token: rep.token })).json.items).toHaveLength(2);
    expect((await create({ name: '经理建' }, mgr.token)).status).toBe(201);
    const b = await createTenant('B');
    expect((await patchRule(id, { isActive: true }, b.token)).status).toBe(404);
    expect((await call(rules.GET, { token: a.token, query: { entity: 'LEAD' } })).json.items).toHaveLength(1);
    expect((await call(ruleItem.DELETE, { token: a.token, params: { id }, method: 'DELETE' })).status).toBe(204);
    const logs = (await prisma.auditLog.findMany({ where: { entityType: 'validation' }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(logs).toEqual(['validation.create', 'validation.create', 'validation.update', 'validation.update', 'validation.create', 'validation.delete']);
    // 上限 / cap
    await prisma.validationRule.createMany({ data: Array.from({ length: 48 }, (_, i) => ({ organizationId: a.org.id, name: `r${i}`, entity: 'DEAL' as const, require: [{ field: 'name', op: 'NOT_EMPTY' }], message: 'x', isActive: false })) });
    expect((await create({ name: '第 51 条' })).json.error.details).toEqual({ name: ['limit_reached'] });
  });
});

describe('validation rules R1 enforcement', () => {
  it('商机：新建与编辑按写入后的值校验；多条失败全部列出；停用不生效 / deals', async () => {
    await bigDealRule();
    await lostRule();
    const r = await newDeal({ amount: '2000000' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'VALIDATION_ERROR', message: '大额商机须填预计成交日', details: { expectedCloseDate: ['大额商机须填预计成交日'] } });
    expect(await prisma.deal.count()).toBe(0);
    const ok = await newDeal({ amount: '2000000', expectedCloseDate: '2026-12-31' });
    expect(ok.status).toBe(201);
    // 编辑：清空日期被拒；改小金额后可以清空 / clearing the date is refused; allowed after lowering the amount
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: ok.json.id }, body: { expectedCloseDate: null }, method: 'PATCH' })).status).toBe(400);
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: ok.json.id }, body: { amount: '100', expectedCloseDate: null }, method: 'PATCH' })).status).toBe(200);
    // 两条同时失败 / two rules fail together
    const two = await call(dealItem.PATCH, { token: a.token, params: { id: ok.json.id }, body: { amount: '3000000', stage: 'CLOSED_LOST' }, method: 'PATCH' });
    expect(two.json.error.details).toEqual({ expectedCloseDate: ['大额商机须填预计成交日'], description: ['请填写输单原因'] });
    expect(two.json.error.message).toBe('大额商机须填预计成交日; 请填写输单原因');
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: ok.json.id }, body: { stage: 'CLOSED_LOST', description: '价格没有竞争力' }, method: 'PATCH' })).status).toBe(200);
    // 停用后不生效 / inactive rules do not apply
    await prisma.validationRule.updateMany({ data: { isActive: false } });
    expect((await newDeal({ amount: '5000000' })).status).toBe(201);
  });

  it('批量改阶段逐条失败；线索规则（未指定字段时归入 rule）/ bulk and leads', async () => {
    await lostRule();
    const d1 = (await newDeal({ description: '有原因' })).json;
    const d2 = (await newDeal()).json;
    const res = await call(dealBulk.POST, { token: a.token, body: { action: 'stage', ids: [d1.id, d2.id], stage: 'CLOSED_LOST' } });
    expect(res.json.succeeded).toEqual([d1.id]);
    expect(res.json.failed).toMatchObject([{ id: d2.id, code: 'VALIDATION_ERROR', message: '请填写输单原因' }]);
    await create({ name: '推荐须填公司', entity: 'LEAD', when: [{ field: 'source', op: 'EQUALS', value: 'REFERRAL' }], require: [{ field: 'company', op: 'NOT_EMPTY' }], message: '推荐来的线索请填写公司', errorField: null });
    const l = await call(leads.POST, { token: rep.token, body: { name: '线索', source: 'REFERRAL' } });
    expect(l.json.error.details).toEqual({ rule: ['推荐来的线索请填写公司'] });
    expect((await call(leads.POST, { token: rep.token, body: { name: '线索', source: 'REFERRAL', company: '某公司' } })).status).toBe(201);
    expect((await call(leads.POST, { token: rep.token, body: { name: '线索', source: 'WEBSITE' } })).status).toBe(201);
  });

  it('不校验：网页表单、导入、工作流改动 / not checked', async () => {
    await create({ name: '线索须有手机', entity: 'LEAD', require: [{ field: 'mobile', op: 'NOT_EMPTY' }], message: '请填写手机' });
    const form = (await call(forms.POST, { token: a.token, body: { name: '官网', title: 'T' } })).json;
    expect((await call(publicForm.POST, { params: { key: form.publicKey }, body: { name: '访客' }, headers: { 'x-forwarded-for': '10.4.0.1' } })).status).toBe(200);
    expect((await call(leadImport.POST, { token: a.token, body: { csv: '姓名\r\n导入的', dryRun: false } })).json.created).toBe(1);
    expect((await call(leads.POST, { token: a.token, body: { name: '手工' } })).status).toBe(400);
    // 工作流把阶段改为输单不受“输单须填原因”约束 / workflow changes bypass validation
    await lostRule();
    await call(workflows.POST, { token: a.token, body: { name: '小额直接输单', entity: 'DEAL', trigger: 'CREATE', conditions: [{ field: 'amount', op: 'LTE', value: '1' }], actions: [{ type: 'UPDATE_FIELD', field: 'stage', value: 'CLOSED_LOST' }] } });
    const d = await newDeal({ amount: '1' });
    expect(d.status).toBe(201);
    expect(d.json.stage).toBe('CLOSED_LOST');
  });
});
