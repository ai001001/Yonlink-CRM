/**
 * 线索评分 第一轮：功能测试（默认设置、保存规则与顺序、校验、审计；新建与修改线索时计分、负分、停用规则、客户端与数据库
 * 直接写入的分数被覆盖；已完成跟进计分、上限、完成与撤销、删除、换关联线索；网页表单与市场活动字段；保存规则后重算全部；
 * 得分明细与分级；列表按评分排序与按分级筛选、导出按分级筛选；导入、批量改状态、回收站恢复后的分数；演示数据）。
 * Lead scoring round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_SCORING } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as activityItem from '@/app/api/activities/[id]/route';
import * as activities from '@/app/api/activities/route';
import * as campaigns from '@/app/api/campaigns/route';
import * as scoring from '@/app/api/lead-scoring/route';
import * as leadBulk from '@/app/api/leads/bulk/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leadScore from '@/app/api/leads/[id]/score/route';
import * as leads from '@/app/api/leads/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const RULES = [
  { kind: 'FIELD_EQUALS', field: 'source', value: 'WEBSITE', points: 20 },
  { kind: 'FIELD_FILLED', field: 'email', points: 10 },
  { kind: 'FIELD_FILLED', field: 'company', points: 5 },
  { kind: 'FIELD_EQUALS', field: 'status', value: 'UNQUALIFIED', points: -40 },
  { kind: 'ACTIVITY_COUNT', maxCount: 2, points: 7 },
];
const save = (body: object) => call(scoring.PUT, { token: a.token, body: { hotScore: 30, warmScore: 15, rules: RULES, ...body }, method: 'PUT' });
const newLead = async (body: object) => (await call(leads.POST, { token: a.token, body: { name: '线索', ...body } })).json;
const scoreOf = async (id: string) => (await prisma.lead.findUniqueOrThrow({ where: { id } })).score;
const addActivity = async (leadId: string, completed: boolean) => (await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '电话', leadId, completed } })).json;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('lead scoring R1 rules', () => {
  it('默认设置、保存与顺序、校验、审计 / defaults, save, validation, audit', async () => {
    expect((await call(scoring.GET, { token: a.token })).json).toEqual({ rules: [], hotScore: 60, warmScore: 30 });
    const l = await newLead({ source: 'WEBSITE', email: 'x@example.com' });
    expect(l.score).toBe(0);
    const r = await save({});
    expect(r.status).toBe(200);
    expect(r.json.rescored).toBe(1);
    expect(r.json.rules.map((x: { position: number; kind: string }) => `${x.position}:${x.kind}`)).toEqual(['0:FIELD_EQUALS', '1:FIELD_FILLED', '2:FIELD_FILLED', '3:FIELD_EQUALS', '4:ACTIVITY_COUNT']);
    expect(r.json).toMatchObject({ hotScore: 30, warmScore: 15 });
    expect(await scoreOf(l.id)).toBe(30);
    // 校验 / validation
    const bad = [
      { rules: [{ kind: 'FIELD_FILLED', field: 'email', points: 0 }] },
      { rules: [{ kind: 'FIELD_FILLED', field: 'email', points: 101 }] },
      { rules: [{ kind: 'FIELD_FILLED', field: 'email', points: 1.5 }] },
      { rules: [{ kind: 'FIELD_FILLED', field: 'fax', points: 5 }] },
      { rules: [{ kind: 'FIELD_EQUALS', field: 'source', value: 'TV', points: 5 }] },
      { rules: [{ kind: 'FIELD_EQUALS', field: 'status', value: 'WEBSITE', points: 5 }] },
      { rules: [{ kind: 'FIELD_EQUALS', field: 'company', value: 'x', points: 5 }] },
      { rules: [{ kind: 'ACTIVITY_COUNT', maxCount: 0, points: 5 }] },
      { rules: [{ kind: 'ACTIVITY_COUNT', maxCount: 51, points: 5 }] },
      { rules: [{ kind: 'FIELD_FILLED', field: 'email', points: 5, maxCount: 3 }] },
      { rules: Array.from({ length: 51 }, () => ({ kind: 'FIELD_FILLED', field: 'email', points: 1 })) },
      { hotScore: 20, warmScore: 20 },
      { hotScore: 1001 },
      { warmScore: -1 },
      { organizationId: a.org.id },
    ];
    for (const body of bad) expect((await save(body)).status).toBe(400);
    expect((await call(scoring.GET, { token: a.token })).json.rules).toHaveLength(5);
    // 审计：规则文本、阈值、重算条数 / audit: rule texts, thresholds, rescored count
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'scoring.update' } });
    expect(log.changes).toEqual({
      rescored: 1,
      rules: [[], ['source=WEBSITE:+20', 'filled:email:+10', 'filled:company:+5', 'status=UNQUALIFIED:-40', 'activities×2:+7']],
      hotScore: [60, 30],
      warmScore: [30, 15],
    });
    // 只改阈值：审计只含阈值与重算条数 / thresholds only
    await save({ hotScore: 40 });
    const log2 = await prisma.auditLog.findFirstOrThrow({ where: { action: 'scoring.update' }, orderBy: { createdAt: 'desc' } });
    expect(log2.changes).toEqual({ rescored: 1, hotScore: [30, 40] });
  });

  it('线索写入时计分：负分、停用规则、空白值、分数不可写入 / scoring on writes', async () => {
    await save({ rules: [...RULES, { kind: 'FIELD_FILLED', field: 'phone', points: 3, isActive: false }] });
    const l = await newLead({ source: 'WEBSITE', email: 'x@example.com', company: '  ', phone: '123' });
    // 来源 20 + 邮箱 10；公司为空白不计；电话规则已停用 / source 20 + email 10; blank company; phone rule inactive
    expect(l.score).toBe(30);
    await call(leadItem.PATCH, { token: a.token, params: { id: l.id }, body: { company: '甲公司', status: 'UNQUALIFIED' }, method: 'PATCH' });
    expect(await scoreOf(l.id)).toBe(-5);
    // 客户端不能提交分数 / clients cannot submit a score
    expect((await call(leads.POST, { token: a.token, body: { name: '作弊', score: 100 } })).status).toBe(400);
    expect((await call(leadItem.PATCH, { token: a.token, params: { id: l.id }, body: { score: 100 }, method: 'PATCH' })).status).toBe(400);
    // 绕过接口直接写数据库也会被触发器覆盖 / a direct database write is overwritten by the trigger
    await prisma.lead.update({ where: { id: l.id }, data: { score: 999 } });
    expect(await scoreOf(l.id)).toBe(-5);
    const created = await prisma.lead.create({ data: { organizationId: a.org.id, name: '直接写入', source: 'WEBSITE', score: 500 } });
    expect(created.score).toBe(20);
  });

  it('已完成跟进计分、上限、完成与撤销、删除、换关联 / completed activities', async () => {
    await save({ rules: [{ kind: 'ACTIVITY_COUNT', maxCount: 2, points: 7 }] });
    const l = await newLead({});
    const other = await newLead({ name: '另一条' });
    const open = await addActivity(l.id, false);
    expect(await scoreOf(l.id)).toBe(0);
    const done1 = await addActivity(l.id, true);
    expect(await scoreOf(l.id)).toBe(7);
    // 完成未完成的跟进 / completing an open activity
    await call(activityItem.PATCH, { token: a.token, params: { id: open.id }, body: { completed: true }, method: 'PATCH' });
    expect(await scoreOf(l.id)).toBe(14);
    // 上限 2 条 / capped at 2
    await addActivity(l.id, true);
    expect(await scoreOf(l.id)).toBe(14);
    // 撤销完成与删除 / reopen and delete
    await call(activityItem.PATCH, { token: a.token, params: { id: open.id }, body: { completed: false }, method: 'PATCH' });
    await call(activityItem.DELETE, { token: a.token, params: { id: done1.id }, method: 'DELETE' });
    expect(await scoreOf(l.id)).toBe(7);
    // 换关联线索：两条线索都重算 / moving an activity rescores both leads
    const moved = await prisma.activity.findFirstOrThrow({ where: { leadId: l.id, completed: true } });
    await prisma.activity.update({ where: { id: moved.id }, data: { leadId: other.id } });
    expect(await scoreOf(l.id)).toBe(0);
    expect(await scoreOf(other.id)).toBe(7);
  });

  it('市场活动与保存规则后重算；得分明细与分级 / campaign field, rescoring, breakdown', async () => {
    const campaign = (await call(campaigns.POST, { token: a.token, body: { name: '广告投放', type: 'ADVERTISEMENT' } })).json;
    const l = await newLead({ source: 'WEBSITE', email: 'x@example.com', campaignId: campaign.id });
    expect(l.score).toBe(0);
    await save({ rules: [...RULES, { kind: 'FIELD_FILLED', field: 'campaign', points: 8 }, { kind: 'FIELD_FILLED', field: 'web_form', points: 9 }] });
    expect(await scoreOf(l.id)).toBe(38);
    await addActivity(l.id, true);
    const detail = (await call(leadScore.GET, { token: a.token, params: { id: l.id } })).json;
    expect(detail).toMatchObject({ score: 45, grade: 'hot', hotScore: 30, warmScore: 15 });
    expect(detail.items.map((i: { kind: string; field: string | null; points: number }) => `${i.kind}:${i.field}:${i.points}`)).toEqual([
      'FIELD_EQUALS:source:20',
      'FIELD_FILLED:email:10',
      'ACTIVITY_COUNT:null:7',
      'FIELD_FILLED:campaign:8',
    ]);
    expect(detail.items.reduce((s: number, i: { points: number }) => s + i.points, 0)).toBe(detail.score);
    // 删除全部规则后归零 / clearing the rules resets to 0
    await save({ rules: [] });
    expect(await scoreOf(l.id)).toBe(0);
    expect((await call(leadScore.GET, { token: a.token, params: { id: l.id } })).json).toMatchObject({ score: 0, grade: 'cold', items: [] });
    expect((await call(leadScore.GET, { token: a.token, params: { id: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
  });
});

describe('lead scoring R1 lists and other write paths', () => {
  it('按评分排序、按分级筛选、导出按分级筛选 / sort, grade filter, export', async () => {
    await save({});
    const hot = await newLead({ name: '热门', source: 'WEBSITE', email: 'h@example.com', company: '甲' });
    const warm = await newLead({ name: '温和', source: 'WEBSITE' });
    const cold = await newLead({ name: '冷淡' });
    expect([hot.score, warm.score, cold.score]).toEqual([35, 20, 0]);
    const names = async (query: Record<string, string>) => (await call(leads.GET, { token: a.token, query })).json.items.map((l: { name: string }) => l.name);
    expect(await names({ sort: 'score' })).toEqual(['热门', '温和', '冷淡']);
    expect(await names({ grade: 'hot' })).toEqual(['热门']);
    expect(await names({ grade: 'warm' })).toEqual(['温和']);
    expect(await names({ grade: 'cold' })).toEqual(['冷淡']);
    expect((await call(leads.GET, { token: a.token, query: { grade: 'boiling' } })).status).toBe(400);
    expect((await call(leads.GET, { token: a.token, query: { sort: 'name' } })).status).toBe(400);
    // 阈值改变后分级随之变化 / grades follow the thresholds
    await save({ hotScore: 20, warmScore: 1 });
    expect(await names({ grade: 'hot' })).toEqual(expect.arrayContaining(['热门', '温和']));
    // 导出按分级筛选 / export honours the grade filter
    const res = await leadExport.GET(new Request('http://localhost/api/leads/export?grade=cold', { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    const csv = await res.text();
    expect(csv).toContain('冷淡');
    expect(csv).not.toContain('热门');
  });

  it('导入、批量改状态、回收站恢复后分数正确 / import, bulk status, restore', async () => {
    await save({ rules: [{ kind: 'FIELD_FILLED', field: 'company', points: 10 }, { kind: 'FIELD_EQUALS', field: 'status', value: 'QUALIFIED', points: 25 }] });
    const imported = await call(leadImport.POST, { token: a.token, body: { csv: '姓名,公司\n导入一,甲公司\n导入二,', dryRun: false } });
    expect(imported.status).toBe(200);
    const rows = await prisma.lead.findMany({ orderBy: { name: 'asc' } });
    expect(rows.map((r) => `${r.name}:${r.score}`)).toEqual(['导入一:10', '导入二:0']);
    await call(leadBulk.POST, { token: a.token, body: { action: 'status', ids: rows.map((r) => r.id), status: 'QUALIFIED' } });
    expect((await prisma.lead.findMany({ orderBy: { name: 'asc' } })).map((r) => r.score)).toEqual([35, 25]);
    // 删除后改规则再恢复：按当前规则计算 / delete, change rules, restore: scored by the current rules
    const target = rows[0]!;
    await call(leadItem.DELETE, { token: a.token, params: { id: target.id }, method: 'DELETE' });
    await save({ rules: [{ kind: 'FIELD_FILLED', field: 'company', points: 3 }] });
    const item = (await call(bin.GET, { token: a.token, query: { entityType: 'lead' } })).json.items[0];
    expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    expect(await scoreOf(target.id)).toBe(3);
  });

  it('演示评分规则 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    expect(await prisma.leadScoringRule.count({ where: { organizationId: org.id } })).toBe(DEMO_SCORING.rules.length);
    expect(await prisma.leadScoringSettings.findUniqueOrThrow({ where: { organizationId: org.id } })).toMatchObject({ hotScore: DEMO_SCORING.hotScore, warmScore: DEMO_SCORING.warmScore });
    // 每条演示线索的分数等于其明细之和，且三个分级都有线索 / every score equals its breakdown and all grades occur
    const rows = await prisma.$queryRaw<{ id: string; score: number; total: number }[]>`
      SELECT l.id, l.score, coalesce((SELECT sum(i.points) FROM lead_score_items(l) i), 0)::int AS total FROM leads l WHERE l.organization_id = ${org.id}::uuid`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.score === r.total)).toBe(true);
    const grades = new Set(rows.map((r) => (r.score >= DEMO_SCORING.hotScore ? 'hot' : r.score >= DEMO_SCORING.warmScore ? 'warm' : 'cold')));
    expect([...grades].sort()).toEqual(['cold', 'hot', 'warm']);
    await seedDemo({ reset: true });
    expect(await prisma.leadScoringRule.count({ where: { organizationId: org.id } })).toBe(DEMO_SCORING.rules.length);
  });
});
