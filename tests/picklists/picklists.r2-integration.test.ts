/**
 * 标准字段可配置 第二轮：集成测试（并发保存串行且结果一致；删除自定义选项与新建使用它的记录互斥；组织隔离；
 * 数据库约束；导出与报表使用组织的自定义名称；转化线索时的阶段；API 密钥权限；演示数据）。
 * Configurable picklists round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as leadExport from '@/app/api/leads/export/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import * as picklistItem from '@/app/api/picklists/[field]/route';
import * as picklists from '@/app/api/picklists/route';
import * as salesExport from '@/app/api/reports/sales/export/route';
import * as accounts from '@/app/api/accounts/route';
import * as deals from '@/app/api/deals/route';
import { prisma } from '@/server/db';
import { DEMO_ORG_NAME, DEMO_PICKLISTS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
type Opt = { value?: string; label?: string | null; isActive: boolean; probability?: number | null };
const put = (field: string, values: Opt[], token = a.token) => call(picklistItem.PUT, { token, params: { field }, body: { values }, method: 'PUT' });
const get = async (token = a.token) => (await call(picklists.GET, { token })).json.fields;
const asBody = (list: { value: string; label: string | null; isActive: boolean; probability: number | null }[]): Opt[] => list.map((o) => ({ value: o.value, label: o.label, isActive: o.isActive, probability: o.probability }));

/** 读取 CSV 导出 / read a CSV export */
async function csv(handler: typeof leadExport.GET, query: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/x');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await handler(new Request(url, { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
  return { status: res.status, text: await res.text() };
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('picklists R2', () => {
  it('并发保存同一字段：串行执行，结果为其中一次的完整配置 / concurrent saves serialize', async () => {
    const base = asBody((await get()).LEAD_SOURCE);
    const versions = Array.from({ length: 6 }, (_, i) => [...base, { label: `渠道${i}`, isActive: true }]);
    const res = await Promise.all(versions.map((v) => put('LEAD_SOURCE', v)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const rows = await prisma.picklistValue.findMany({ where: { organizationId: a.org.id, field: 'LEAD_SOURCE' }, orderBy: { position: 'asc' } });
    expect(rows).toHaveLength(base.length + 1);
    expect(rows.map((r) => r.position)).toEqual([...Array(base.length + 1).keys()]);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, entityType: 'picklist' } })).toBe(6);
  });

  it('删除自定义选项与使用它的新建互斥 / removing a custom option vs creating a record with it', async () => {
    const list = (await put('LEAD_SOURCE', [...asBody((await get()).LEAD_SOURCE), { label: '临时渠道', isActive: true }])).json.items as { value: string; label: string | null; isActive: boolean; probability: number | null }[];
    const tmp = list.find((o) => o.label === '临时渠道')!.value;
    const without = asBody(list).filter((o) => o.value !== tmp);
    const [removed, ...created] = await Promise.all([put('LEAD_SOURCE', without), ...Array.from({ length: 4 }, (_, i) => call(leads.POST, { token: a.token, body: { name: `线索${i}`, source: tmp } }))]);
    const used = await prisma.lead.count({ where: { organizationId: a.org.id, source: tmp } });
    const stillThere = await prisma.picklistValue.count({ where: { organizationId: a.org.id, field: 'LEAD_SOURCE', value: tmp } });
    // 不变量：使用该选项的记录存在时，选项仍在配置中 / invariant: while records use it, the option stays configured
    if (used > 0) expect(stillThere).toBe(1);
    if (removed.status === 200) expect(stillThere).toBe(0);
    else expect(removed.json.error.details).toEqual({ values: [`in_use:${tmp}`] });
    expect(created.filter((r) => r.status === 201)).toHaveLength(used);
  });

  it('组织隔离与数据库约束 / isolation and database constraints', async () => {
    const b = await createTenant('B');
    const list = (await put('INDUSTRY', [...asBody((await get()).INDUSTRY), { label: 'A的行业', isActive: true }])).json.items as { value: string; label: string | null }[];
    const code = list.find((o) => o.label === 'A的行业')!.value;
    expect((await get(b.token)).INDUSTRY.some((o: { value: string }) => o.value === code)).toBe(false);
    expect((await call(accounts.POST, { token: b.token, body: { name: 'B客户', industry: code } })).json.error.details).toEqual({ industry: ['invalid_option'] });
    // 同名可在不同组织 / the same label is fine in another organization
    expect((await put('INDUSTRY', [...asBody((await get(b.token)).INDUSTRY), { label: 'A的行业', isActive: true }], b.token)).status).toBe(200);
    const org = a.org.id;
    const bad = [
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'INDUSTRY', value: 'bad', position: 99 } }),
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'INDUSTRY', value: 'X_ONE', label: ' 空格 ', position: 99 } }),
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'INDUSTRY', value: 'X_TWO', probability: 10, position: 99 } }),
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'INDUSTRY', value: 'X_THREE', label: 'a的行业', position: 99 } }),
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'DEAL_STAGE', value: 'CLOSED_WON', isActive: false, position: 99 } }),
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'LEAD_STATUS', value: 'CONVERTED', isActive: false, position: 99 } }),
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'DEAL_STAGE', value: 'CLOSED_LOST', probability: 5, position: 99 } }),
      () => prisma.picklistValue.create({ data: { organizationId: org, field: 'DEAL_STAGE', value: 'PROPOSAL', probability: 101, position: 99 } }),
    ];
    for (const [i, f] of bad.entries()) await expect(f(), `case ${i}`).rejects.toThrow();
  });

  it('导出与报表使用自定义名称；转化线索的阶段须启用 / exports use custom labels; conversion checks the stage', async () => {
    const src = (await put('LEAD_SOURCE', [...asBody((await get()).LEAD_SOURCE).map((o) => (o.value === 'WEBSITE' ? { ...o, label: '公司官网' } : o)), { label: '直播间', isActive: true }])).json.items as { value: string; label: string | null }[];
    const live = src.find((o) => o.label === '直播间')!.value;
    await call(leads.POST, { token: a.token, body: { name: '官网线索', source: 'WEBSITE' } });
    const lead = (await call(leads.POST, { token: a.token, body: { name: '直播线索', source: live } })).json;
    const out = await csv(leadExport.GET);
    expect(out.status).toBe(200);
    expect(out.text).toContain('公司官网');
    expect(out.text).toContain('直播间');
    expect(out.text).not.toContain(live);
    await put('DEAL_STAGE', asBody((await get()).DEAL_STAGE).map((o) => (o.value === 'PROPOSAL' ? { ...o, label: '已报价' } : o.value === 'QUALIFICATION' ? { ...o, isActive: false } : o)));
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acct.id, stage: 'PROPOSAL' } });
    const today = new Date().toISOString().slice(0, 10);
    const report = await csv(salesExport.GET as typeof leadExport.GET, { from: `${today.slice(0, 4)}-01-01`, to: today });
    expect(report.text).toContain('已报价');
    expect(report.text).toContain('直播间');
    // 转化时选择已停用的阶段被拒绝；线索未转化 / converting with an inactive stage is refused
    const conv = await call(convert.POST, { token: a.token, params: { id: lead.id }, body: { account: { mode: 'new' }, deal: { name: '转化商机', stage: 'QUALIFICATION' } } });
    expect(conv.json.error.details).toEqual({ 'deal.stage': ['inactive_option'] });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).convertedAt).toBeNull();
    expect((await call(convert.POST, { token: a.token, params: { id: lead.id }, body: { account: { mode: 'new' }, deal: { name: '转化商机', stage: 'PROPOSAL' } } })).status).toBe(200);
  });

  it('API 密钥与角色 / API keys and roles', async () => {
    const sales = await addUser(a.org.id, 'SALES', '销售');
    const keys = await import('@/app/api/api-keys/route');
    const adminKey = (await call(keys.POST, { token: a.token, body: { name: '管理员密钥', userId: a.user.id } })).json.key;
    const salesKey = (await call(keys.POST, { token: a.token, body: { name: '销售密钥', userId: sales.user.id } })).json.key;
    const base = asBody((await get()).ACTIVITY_TYPE);
    expect((await put('ACTIVITY_TYPE', base, salesKey)).status).toBe(403);
    expect((await put('ACTIVITY_TYPE', base.map((o) => (o.value === 'TASK' ? { ...o, label: '待办' } : o)), adminKey)).status).toBe(200);
    expect((await get(salesKey)).ACTIVITY_TYPE.find((o: { value: string }) => o.value === 'TASK').label).toBe('待办');
  });

  it('演示数据：自定义选项、带【演示】标注、重建 / demo data', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.picklistValue.findMany({ where: { organizationId: org.id, label: { not: null } } });
    expect(rows.map((r) => [r.field, r.value, r.label]).sort()).toEqual(DEMO_PICKLISTS.map((p) => [p.field, p.value, p.label]).sort());
    for (const p of DEMO_PICKLISTS) expect(p.label).toContain('【演示】');
    // 内置选项全部保留且启用；其他字段使用默认 / built-ins kept and active; other fields use defaults
    expect(await prisma.picklistValue.count({ where: { organizationId: org.id, isActive: false } })).toBe(0);
    expect(await prisma.picklistValue.count({ where: { organizationId: org.id, field: { in: ['LEAD_STATUS', 'DEAL_STAGE', 'ACTIVITY_TYPE'] } } })).toBe(0);
    await seedDemo({ reset: true });
    expect(await prisma.picklistValue.count({ where: { organizationId: org.id, label: { not: null } } })).toBe(DEMO_PICKLISTS.length);
  });
});
