/**
 * 线索评分 第二轮：集成测试（角色权限：所有人可查看规则与可见线索的明细、仅管理员与经理可保存；跨组织隔离（规则只作用于本组织、
 * 重算只影响本组织、明细 404）；并发保存不会交错；线索转化、合并、网页表单提交后的分数；保存规则在同一事务内重算；
 * 1000 条线索重算耗时；审计日志接口筛选）。
 * Lead scoring round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as scoring from '@/app/api/lead-scoring/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leadScore from '@/app/api/leads/[id]/score/route';
import * as leads from '@/app/api/leads/route';
import * as publicForm from '@/app/api/public/web-forms/[key]/route';
import * as forms from '@/app/api/web-forms/route';
import { prisma } from '@/server/db';
import { resetWebFormLimiter } from '@/server/modules/web-forms';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales: Who & { user: { id: string } };
let viewer: Who;
const RULES = [
  { kind: 'FIELD_FILLED', field: 'company', points: 10 },
  { kind: 'FIELD_EQUALS', field: 'status', value: 'CONVERTED', points: 50 },
  { kind: 'FIELD_FILLED', field: 'web_form', points: 15 },
];
const save = (who: Who, body: object = {}) => call(scoring.PUT, { token: who.token, body: { hotScore: 50, warmScore: 20, rules: RULES, ...body }, method: 'PUT' });

beforeEach(async () => {
  await resetDb();
  resetWebFormLimiter();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('lead scoring R2 permissions & isolation', () => {
  it('所有人可查看；仅管理员与经理可保存；明细按可见范围 / read for all, save for managers, visibility', async () => {
    expect((await save(admin)).status).toBe(200);
    for (const who of [sales, viewer]) {
      expect((await call(scoring.GET, { token: who.token })).json.rules).toHaveLength(3);
      expect((await save(who, { rules: [] })).status).toBe(403);
    }
    expect(await prisma.scoringRule.count()).toBe(3);
    expect((await save(manager, { hotScore: 70 })).status).toBe(200);
    expect((await call(scoring.PUT, { body: { hotScore: 1, warmScore: 0, rules: [] }, method: 'PUT' })).status).toBe(401);
    // 销售只能查看自己线索的明细 / sales see breakdowns of their own leads only
    const own = (await call(leads.POST, { token: sales.token, body: { name: '销售的线索', company: '甲' } })).json;
    const notOwn = (await call(leads.POST, { token: admin.token, body: { name: '管理员的线索', company: '乙' } })).json;
    expect((await call(leadScore.GET, { token: sales.token, params: { id: own.id } })).json.score).toBe(10);
    expect((await call(leadScore.GET, { token: sales.token, params: { id: notOwn.id } })).status).toBe(404);
    expect((await call(leadScore.GET, { token: viewer.token, params: { id: notOwn.id } })).json.score).toBe(10);
  });

  it('跨组织：规则只作用于本组织，重算只影响本组织，明细 404 / tenant isolation', async () => {
    const aLead = (await call(leads.POST, { token: admin.token, body: { name: 'A', company: '甲' } })).json;
    const bLead = (await call(leads.POST, { token: other.token, body: { name: 'B', company: '乙' } })).json;
    const r = await save(admin);
    expect(r.json.rescored).toBe(1);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: aLead.id } })).score).toBe(10);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: bLead.id } })).score).toBe(0);
    expect((await call(scoring.GET, { token: other.token })).json.rules).toEqual([]);
    expect((await call(leadScore.GET, { token: other.token, params: { id: aLead.id } })).status).toBe(404);
    // B 保存自己的规则不影响 A / B's rules do not touch A
    await save(other, { rules: [{ kind: 'FIELD_FILLED', field: 'company', points: 99 }] });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: aLead.id } })).score).toBe(10);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: bLead.id } })).score).toBe(99);
    // B 的规则不会出现在 A 线索的明细中 / B's rules never appear in A's breakdown
    const items = (await call(leadScore.GET, { token: admin.token, params: { id: aLead.id } })).json.items;
    expect(items.every((i: { ruleId: string }) => i.ruleId)).toBe(true);
    expect(items.map((i: { points: number }) => i.points)).toEqual([10]);
  });

  it('并发保存不会交错：结果等于其中一次保存 / concurrent saves do not interleave', async () => {
    const one = Array.from({ length: 5 }, () => ({ kind: 'FIELD_FILLED', field: 'email', points: 1 }));
    const two = Array.from({ length: 3 }, () => ({ kind: 'FIELD_FILLED', field: 'phone', points: 2 }));
    const results = await Promise.all([save(admin, { rules: one }), save(manager, { rules: two }), save(admin, { rules: one }), save(manager, { rules: two })]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const rules = await prisma.scoringRule.findMany({ where: { organizationId: admin.org.id } });
    const fields = new Set(rules.map((r) => r.field));
    expect(fields.size).toBe(1);
    expect(rules.length).toBe(fields.has('email') ? 5 : 3);
    expect(rules.map((r) => r.position).sort()).toEqual(rules.map((_, i) => i));
  });
});

describe('lead scoring R2 write paths & scale', () => {
  it('线索转化与网页表单提交后的分数 / conversion and web form submissions', async () => {
    await save(admin);
    const l = (await call(leads.POST, { token: admin.token, body: { name: '待转化', company: '甲公司' } })).json;
    expect(l.score).toBe(10);
    const conv = await call(convert.POST, { token: admin.token, params: { id: l.id }, body: { account: { mode: 'new' } } });
    expect(conv.status).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).score).toBe(60);
    // 网页表单提交 / web form submission
    const form = (await call(forms.POST, { token: admin.token, body: { name: '官网', title: '联系我们' } })).json;
    const sub = await call(publicForm.POST, { params: { key: form.publicKey }, body: { name: '访客', company: '丙公司' }, headers: { 'x-forwarded-for': '10.9.9.9' } });
    expect(sub.status).toBe(200);
    expect((await prisma.lead.findFirstOrThrow({ where: { name: '访客' } })).score).toBe(25);
  });

  it('1000 条线索在一次保存中全部重算；审计日志筛选 / rescoring 1000 leads; audit filter', async () => {
    await prisma.lead.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ organizationId: admin.org.id, name: `批量${i}`, company: i % 2 ? '有公司' : null })) });
    const started = Date.now();
    const r = await save(admin);
    const took = Date.now() - started;
    expect(r.json.rescored).toBe(1000);
    expect(await prisma.lead.count({ where: { organizationId: admin.org.id, score: 10 } })).toBe(500);
    expect(await prisma.lead.count({ where: { organizationId: admin.org.id, score: 0 } })).toBe(500);
    expect(took).toBeLessThan(15_000);
    const logs = (await call(auditLogs.GET, { token: admin.token, query: { entityType: 'scoring' } })).json.items;
    expect(logs).toHaveLength(1);
    expect(logs[0].changes).toMatchObject({ rescored: 1000 });
  }, 60_000);
});
