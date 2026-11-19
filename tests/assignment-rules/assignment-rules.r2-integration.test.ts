/**
 * 线索分配规则 第二轮：集成测试（并发提交时轮流分配不重复且均匀；保存与分配并发；组织隔离与数据库复合外键；数据库约束；
 * 引用的市场活动删除后条件不再匹配且需先移除才能保存；审计日志接口按对象筛选；演示数据规则与按规则分配的表单）。
 * Assignment rules round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ASSIGNMENT_RULES, DEMO_ORG_NAME, DEMO_USERS, DEMO_WEB_FORMS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as rulesRoute from '@/app/api/assignment-rules/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as campaignItem from '@/app/api/campaigns/[id]/route';
import * as campaigns from '@/app/api/campaigns/route';
import * as leads from '@/app/api/leads/route';
import * as publicForm from '@/app/api/public/web-forms/[key]/route';
import * as forms from '@/app/api/web-forms/route';
import { prisma } from '@/server/db';
import { resetWebFormLimiter } from '@/server/modules/web-forms';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let s1: Awaited<ReturnType<typeof addUser>>;
let s2: Awaited<ReturnType<typeof addUser>>;
let ipSeq = 0;

const save = (rules: object[], token = a.token) => call(rulesRoute.PUT, { token, body: { rules }, method: 'PUT' });
const submit = (key: string, body: object) => call(publicForm.POST, { params: { key }, body, headers: { 'x-forwarded-for': `10.2.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` } });

beforeEach(async () => {
  await resetDb();
  resetWebFormLimiter();
  a = await createTenant('A');
  s1 = await addUser(a.org.id, 'SALES', '销售一');
  s2 = await addUser(a.org.id, 'SALES', '销售二');
});

describe('assignment rules R2 concurrency', () => {
  it('20 个并发提交：指针 1–20 各取一次，两人各 10 条 / concurrent submissions take distinct turns', async () => {
    await save([{ name: '全部', userIds: [s1.user.id, s2.user.id] }]);
    const form = (await call(forms.POST, { token: a.token, body: { name: '并发', title: 'T', assignByRule: true } })).json;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(form.publicKey, { name: `并发${i}` })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const counts = await prisma.lead.groupBy({ by: ['ownerId'], _count: { _all: true }, where: { organizationId: a.org.id } });
    expect(Object.fromEntries(counts.map((c) => [c.ownerId, c._count._all]))).toEqual({ [s1.user.id]: 10, [s2.user.id]: 10 });
    expect((await prisma.assignmentRule.findFirstOrThrow()).cursor).toBe(20);
    expect((await prisma.webForm.findFirstOrThrow({ where: { id: form.id } })).submissionCount).toBe(20);
  });

  it('保存与分配并发：每条提交都成功且都有负责人（保存期间的提交等待并按新规则分配）/ saves racing submissions', async () => {
    const s3 = await addUser(a.org.id, 'SALES', '销售三');
    await save([{ name: '旧', userIds: [s1.user.id] }]);
    const form = (await call(forms.POST, { token: a.token, body: { name: '并发保存', title: 'T', assignByRule: true } })).json;
    const jobs: Promise<{ status: number }>[] = [];
    for (let i = 0; i < 30; i++) {
      jobs.push(submit(form.publicKey, { name: `竞争${i}` }));
      if (i % 10 === 4) jobs.push(save([{ name: `新${i}`, userIds: i === 24 ? [s3.user.id] : [s1.user.id, s3.user.id] }]));
    }
    expect((await Promise.all(jobs)).map((r) => r.status).every((s) => s === 200)).toBe(true);
    const owners = (await prisma.lead.findMany({ where: { organizationId: a.org.id }, select: { ownerId: true } })).map((l) => l.ownerId);
    expect(owners).toHaveLength(30);
    // 没有一条因读到被替换的规则而落空 / none fell through because it read a replaced rule
    expect(owners.filter((o) => o !== s1.user.id && o !== s3.user.id)).toEqual([]);
    const rules = await prisma.assignmentRule.findMany();
    // 并发保存按取得锁的先后生效，最终只剩其中一组规则 / concurrent saves apply in lock order; exactly one set remains
    expect(rules).toHaveLength(1);
    expect(['新4', '新14', '新24']).toContain(rules[0]!.name);
    expect(await prisma.auditLog.count({ where: { action: 'assignment.update' } })).toBe(4);
  });
});

describe('assignment rules R2 isolation and constraints', () => {
  it('组织隔离：B 的规则不影响 A；复合外键拒绝跨组织负责人 / tenant isolation', async () => {
    const b = await createTenant('B');
    const bRep = await addUser(b.org.id, 'SALES', 'B销售');
    expect((await save([{ name: 'B 全部', userIds: [bRep.user.id] }], b.token)).status).toBe(200);
    const form = (await call(forms.POST, { token: a.token, body: { name: 'A 表单', title: 'T', assignByRule: true } })).json;
    await submit(form.publicKey, { name: 'A 访客' });
    expect((await prisma.lead.findFirstOrThrow({ where: { name: 'A 访客' } })).ownerId).toBeNull();
    const bRule = await prisma.assignmentRule.findFirstOrThrow({ where: { organizationId: b.org.id } });
    expect((await prisma.assignmentRule.findFirstOrThrow({ where: { organizationId: b.org.id } })).cursor).toBe(0);
    // 数据库层面：B 的规则不能挂 A 的用户 / the database rejects cross-org users
    await expect(prisma.$executeRaw`INSERT INTO assignment_rule_users (organization_id, rule_id, user_id, position) VALUES (${b.org.id}::uuid, ${bRule.id}::uuid, ${s1.user.id}::uuid, 5)`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO assignment_rule_users (organization_id, rule_id, user_id, position) VALUES (${a.org.id}::uuid, ${bRule.id}::uuid, ${s1.user.id}::uuid, 5)`).rejects.toThrow();
  });

  it('数据库约束：条件必须是数组且最多 5 条、名称非空、表单负责人与按规则互斥 / database checks', async () => {
    await save([{ name: '规则', userIds: [s1.user.id] }]);
    const id = (await prisma.assignmentRule.findFirstOrThrow()).id;
    await expect(prisma.$executeRaw`UPDATE assignment_rules SET conditions = '{"a":1}'::jsonb WHERE id = ${id}::uuid`).rejects.toThrow(/assignment_rules_check/);
    await expect(prisma.$executeRaw`UPDATE assignment_rules SET conditions = '[1,2,3,4,5,6]'::jsonb WHERE id = ${id}::uuid`).rejects.toThrow(/assignment_rules_check/);
    await expect(prisma.$executeRaw`UPDATE assignment_rules SET name = '  ' WHERE id = ${id}::uuid`).rejects.toThrow(/assignment_rules_check/);
    await expect(prisma.$executeRaw`UPDATE assignment_rules SET cursor = -1 WHERE id = ${id}::uuid`).rejects.toThrow(/assignment_rules_check/);
    const form = (await call(forms.POST, { token: a.token, body: { name: '互斥', title: 'T', assignByRule: true } })).json;
    await expect(prisma.$executeRaw`UPDATE web_forms SET owner_id = ${s1.user.id}::uuid WHERE id = ${form.id}::uuid`).rejects.toThrow(/web_forms_assign_check/);
  });

  it('引用的市场活动删除后：显示为缺失、条件不再匹配、需移除条件后才能保存 / deleted campaign references', async () => {
    const c = (await call(campaigns.POST, { token: a.token, body: { name: '临时活动', type: 'EMAIL' } })).json;
    await save([{ name: '活动', userIds: [s1.user.id], conditions: [{ field: 'campaign', op: 'EQUALS', value: c.id }] }]);
    expect((await call(campaignItem.DELETE, { token: a.token, params: { id: c.id }, method: 'DELETE' })).status).toBe(204);
    const r = (await call(rulesRoute.GET, { token: a.token })).json;
    expect(r.rules[0].conditions[0].value).toBe(c.id);
    expect(r.names.campaign).toEqual({});
    const again = await save([{ name: '活动', userIds: [s1.user.id], conditions: [{ field: 'campaign', op: 'EQUALS', value: c.id }] }]);
    expect(again.json.error.details).toEqual({ 'rules.0.conditions.0': ['not_found'] });
  });
});

describe('assignment rules R2 audit and demo', () => {
  it('审计日志接口按对象 assignment 筛选；线索手工新建不受规则影响 / audit filter; manual creation unaffected', async () => {
    await save([{ name: '全部', userIds: [s1.user.id] }]);
    const logs = await call(auditLogs.GET, { token: a.token, query: { entityType: 'assignment' } });
    expect(logs.json.items).toHaveLength(1);
    expect(logs.json.items[0]).toMatchObject({ action: 'assignment.update', entityType: 'assignment' });
    // 手工新建仍归当前用户 / manual creation still defaults to the creator
    const lead = (await call(leads.POST, { token: a.token, body: { name: '手工' } })).json;
    expect(lead.ownerId).toBe(a.user.id);
    expect((await prisma.assignmentRule.findFirstOrThrow()).cursor).toBe(0);
  });

  it('演示数据：4 条规则与负责人、官网表单按规则分配，提交后两位销售轮流 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rules = await prisma.assignmentRule.findMany({
      where: { organizationId: org.id },
      orderBy: { position: 'asc' },
      include: { users: { orderBy: { position: 'asc' }, include: { user: { select: { email: true } } } } },
    });
    const email = (k: string) => DEMO_USERS.find((u) => u.key === k)!.email;
    expect(rules.map((r) => [r.name, r.conditions, r.users.map((u) => u.user.email)])).toEqual(DEMO_ASSIGNMENT_RULES.map((r) => [r.name, r.conditions, r.users.map(email)]));
    const webForm = DEMO_WEB_FORMS.find((f) => f.assignByRule)!;
    const form = await prisma.webForm.findFirstOrThrow({ where: { organizationId: org.id, name: webForm.name } });
    expect(form).toMatchObject({ assignByRule: true, ownerId: null });
    await submit(form.publicKey, { name: '演示访客一', email: 'v1@example.com' });
    await submit(form.publicKey, { name: '演示访客二', email: 'v2@example.com' });
    const owners = await prisma.lead.findMany({ where: { organizationId: org.id, name: { startsWith: '演示访客' } }, orderBy: { name: 'asc' }, include: { owner: { select: { email: true } } } });
    // 官网规则：王芳、陈静轮流（“演示访客一” < “演示访客二” 按名称排序）/ the website rule alternates the two reps
    expect(new Set(owners.map((l) => l.owner?.email))).toEqual(new Set([email('sales1'), email('sales2')]));
    // 重置可重复执行 / the reset is repeatable
    await seedDemo({ reset: true });
    expect(await prisma.assignmentRule.count({ where: { organizationId: org.id } })).toBe(DEMO_ASSIGNMENT_RULES.length);
  });
});
