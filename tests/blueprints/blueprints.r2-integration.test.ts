/**
 * 流程蓝图 第二轮：集成测试（同一记录并发执行不同转换只成功一个；并发启用只成功一个；数据库约束；
 * 保存的转换数据损坏时安全降级；组织隔离；转换与普通编辑并发；演示蓝图启用后按流程推进）。
 * Blueprints round 2: integration tests.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_BLUEPRINT, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as bpItem from '@/app/api/blueprints/[id]/route';
import * as bpTransitions from '@/app/api/blueprints/transitions/route';
import * as blueprints from '@/app/api/blueprints/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import { hashToken } from '@/server/auth';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const ALL = ['ADMIN', 'MANAGER', 'SALES'];
const TRANSITIONS = [
  { name: '需求分析', from: ['QUALIFICATION'], to: 'NEEDS_ANALYSIS', roles: ALL },
  { name: '输单', from: ['QUALIFICATION', 'NEEDS_ANALYSIS'], to: 'CLOSED_LOST', roles: ALL },
];
const newBp = (body: object, token = a.token) => call(blueprints.POST, { token, body: { name: '流程', entity: 'DEAL', transitions: TRANSITIONS, ...body } });
const runTr = (id: string, transitionId: string, token = a.token, extra: object = {}) => call(bpTransitions.POST, { token, body: { entity: 'DEAL', id, transitionId, ...extra } });
const ids = (bp: { transitions: { id: string; name: string }[] }) => Object.fromEntries(bp.transitions.map((x) => [x.name, x.id]));

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('blueprints R2', () => {
  it('并发：同一记录同时执行两个转换只成功一个；同时启用两个蓝图只成功一个 / concurrency', async () => {
    const bp = (await newBp({ isActive: true })).json;
    const t = ids(bp);
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    for (let i = 0; i < 5; i++) {
      const d = (await call(deals.POST, { token: a.token, body: { name: `商机${i}`, accountId: acc.id } })).json;
      const [x, y] = await Promise.all([runTr(d.id, t['需求分析']!), runTr(d.id, t['输单']!)]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const loser = x.status === 409 ? x : y;
      expect(['state_changed', 'not_available']).toContain(Object.values(loser.json.error.details as Record<string, string[]>)[0]![0]);
      const stage = (await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).stage;
      expect([x.status === 200 ? 'NEEDS_ANALYSIS' : 'CLOSED_LOST']).toEqual([stage]);
      expect(await prisma.dealStageHistory.count({ where: { dealId: d.id } })).toBe(2);
    }
    // 并发启用 / concurrent activation
    await prisma.blueprint.updateMany({ data: { isActive: false } });
    const other = (await newBp({ name: '另一个' })).json;
    const res = await Promise.all([bp.id, other.id].map((id) => call(bpItem.PATCH, { token: a.token, params: { id }, body: { isActive: true }, method: 'PATCH' })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.blueprint.count({ where: { isActive: true } })).toBe(1);
  });

  it('数据库约束、损坏的转换数据、组织隔离 / constraints, corrupted data, isolation', async () => {
    const bp = (await newBp({ isActive: true })).json;
    const other = (await newBp({ name: '另一个' })).json;
    await expect(prisma.$executeRaw`UPDATE blueprints SET name = ' ' WHERE id = ${bp.id}::uuid`).rejects.toThrow(/blueprints_check/);
    await expect(prisma.$executeRaw`UPDATE blueprints SET transitions = '[]'::jsonb WHERE id = ${bp.id}::uuid`).rejects.toThrow(/blueprints_check/);
    await expect(prisma.$executeRaw`UPDATE blueprints SET transitions = '{}'::jsonb WHERE id = ${bp.id}::uuid`).rejects.toThrow(/blueprints_check/);
    await expect(prisma.$executeRaw`UPDATE blueprints SET transitions = (SELECT jsonb_agg(x) FROM generate_series(1, 21) x) WHERE id = ${bp.id}::uuid`).rejects.toThrow(/blueprints_check/);
    await expect(prisma.$executeRaw`UPDATE blueprints SET is_active = true WHERE id = ${other.id}::uuid`).rejects.toThrow(/blueprints_one_active_per_entity/);
    await expect(prisma.$executeRaw`UPDATE blueprints SET name = ' 流程 ' WHERE id = ${other.id}::uuid`).rejects.toThrow(/blueprints_organization_id_name_key/);
    // 损坏的转换数据：没有可用转换，执行返回未知转换，受控字段仍被锁定 / corrupted transitions degrade safely
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const d = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id } })).json;
    await prisma.$executeRaw`UPDATE blueprints SET transitions = '[{"name": 1}]'::jsonb WHERE id = ${bp.id}::uuid`;
    expect((await call(bpTransitions.GET, { token: a.token, query: { entity: 'DEAL', id: d.id } })).json.transitions).toEqual([]);
    expect((await runTr(d.id, ids(bp)['需求分析']!)).json.error.details).toEqual({ transitionId: ['not_found'] });
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: d.id }, body: { stage: 'PROPOSAL' }, method: 'PATCH' })).json.error.code).toBe('BLUEPRINT_CONTROLLED');
    // 组织隔离：B 的记录不受 A 的蓝图影响，A 的转换不能用于 B 的记录 / isolation
    const b = await createTenant('B');
    const bAcc = (await call(accounts.POST, { token: b.token, body: { name: 'B 客户' } })).json;
    const bd = (await call(deals.POST, { token: b.token, body: { name: 'B 商机', accountId: bAcc.id } })).json;
    expect((await call(dealItem.PATCH, { token: b.token, params: { id: bd.id }, body: { stage: 'PROPOSAL' }, method: 'PATCH' })).json.stage).toBe('PROPOSAL');
    expect((await call(blueprints.GET, { token: b.token })).json.items).toEqual([]);
    await prisma.$executeRaw`UPDATE blueprints SET transitions = ${JSON.stringify(bp.transitions)}::jsonb WHERE id = ${bp.id}::uuid`;
    expect((await runTr(d.id, ids(bp)['需求分析']!, b.token)).json.error.details).toEqual({ transitionId: ['no_blueprint'] });
    expect((await call(bpTransitions.POST, { token: a.token, body: { entity: 'DEAL', id: bd.id, transitionId: ids(bp)['需求分析'] } })).status).toBe(404);
  });

  it('转换与普通编辑并发：编辑其他字段不受影响，结果一致 / transitions alongside other edits', async () => {
    const bp = (await newBp({ isActive: true })).json;
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const d = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id } })).json;
    const [tr, ed] = await Promise.all([runTr(d.id, ids(bp)['需求分析']!), call(dealItem.PATCH, { token: a.token, params: { id: d.id }, body: { name: '并发改名' }, method: 'PATCH' })]);
    expect([tr.status, ed.status]).toEqual([200, 200]);
    expect(await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ stage: 'NEEDS_ANALYSIS', name: '并发改名' });
  });

  it('演示蓝图：默认停用；启用后按流程推进到赢单 / demo blueprint', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const bp = await prisma.blueprint.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(bp).toMatchObject({ name: DEMO_BLUEPRINT.name, entity: 'DEAL', isActive: false });
    const session = async (email: string) => {
      const u = await prisma.user.findUniqueOrThrow({ where: { email } });
      const token = randomBytes(32).toString('base64url');
      await prisma.session.create({ data: { userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
      return { token, id: u.id };
    };
    const admin = await session('admin@demo.yonlink.test');
    const wang = await session('sales1@demo.yonlink.test');
    const manager = await session('manager@demo.yonlink.test');
    expect((await call(bpItem.PATCH, { token: admin.token, params: { id: bp.id }, body: { isActive: true }, method: 'PATCH' })).json.isActive).toBe(true);
    const deal = await prisma.deal.findFirstOrThrow({ where: { organizationId: org.id, ownerId: wang.id, stage: 'QUALIFICATION', lineItems: { none: {} } } });
    const t = ids(bp as unknown as { transitions: { id: string; name: string }[] });
    const run = (token: string, name: string, extra: object = {}) => call(bpTransitions.POST, { token, body: { entity: 'DEAL', id: deal.id, transitionId: t[name], ...extra } });
    expect((await run(wang.token, '开始需求分析', { fields: { expectedCloseDate: '2027-03-31' } })).json.stage).toBe('NEEDS_ANALYSIS');
    expect((await run(wang.token, '提交方案', { fields: { amount: '120000' } })).json.stage).toBe('PROPOSAL');
    expect((await run(wang.token, '进入谈判', { note: '客户要求降价 3%' })).json.stage).toBe('NEGOTIATION');
    expect((await run(wang.token, '确认赢单', { note: '签约' })).status).toBe(403);
    const won = await run(manager.token, '确认赢单', { note: '客户已签约' });
    expect(won.json.stage, JSON.stringify(won.json)).toBe('CLOSED_WON');
    expect((await call(dealItem.PATCH, { token: admin.token, params: { id: deal.id }, body: { stage: 'NEGOTIATION' }, method: 'PATCH' })).json.error.code).toBe('BLUEPRINT_CONTROLLED');
  });
});
