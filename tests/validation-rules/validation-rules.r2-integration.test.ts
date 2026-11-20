/**
 * 字段验证规则 第二轮：集成测试（组织隔离；绕过接口写入的损坏规则被跳过；数据库约束；API 密钥调用同样受约束；
 * 审计日志按对象筛选；演示规则存在且全部演示商机都满足（编辑不会被误拦）；50 条启用规则时保存耗时）。
 * Validation rules round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_VALIDATION_RULES } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as apiKeys from '@/app/api/api-keys/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as deals from '@/app/api/deals/route';
import * as rules from '@/app/api/validation-rules/route';
import { prisma } from '@/server/db';
import { assertValidRecord } from '@/server/modules/validation-rules';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
const rule = (body: object = {}, token = a.token) => call(rules.POST, { token, body: { name: '大额', entity: 'DEAL', when: [{ field: 'amount', op: 'GTE', value: '1000000' }], require: [{ field: 'expectedCloseDate', op: 'NOT_EMPTY' }], message: '请填写预计成交日', ...body } });
const newDeal = (body: object, token = a.token) => call(deals.POST, { token, body: { name: '商机', accountId: acc.id, ...body } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
});

describe('validation rules R2', () => {
  it('组织隔离；损坏规则被跳过；数据库约束 / isolation, corrupted rules, constraints', async () => {
    const b = await createTenant('B');
    expect((await rule({}, b.token)).status).toBe(201);
    expect((await newDeal({ amount: '2000000' })).status).toBe(201);
    const r = (await rule()).json;
    expect((await newDeal({ amount: '2000000' })).status).toBe(400);
    await prisma.validationRule.update({ where: { id: r.id }, data: { require: [{ unknown: true }] } });
    expect((await newDeal({ amount: '2000000' })).status).toBe(201);
    await expect(prisma.$executeRaw`UPDATE validation_rules SET require = '[]'::jsonb WHERE id = ${r.id}::uuid`).rejects.toThrow(/validation_rules_check/);
    await expect(prisma.$executeRaw`UPDATE validation_rules SET "when" = '{}'::jsonb WHERE id = ${r.id}::uuid`).rejects.toThrow(/validation_rules_check/);
    await expect(prisma.$executeRaw`UPDATE validation_rules SET message = ' ' WHERE id = ${r.id}::uuid`).rejects.toThrow(/validation_rules_check/);
    await expect(prisma.validationRule.create({ data: { organizationId: a.org.id, name: '大额'.toLowerCase(), entity: 'DEAL', require: [{ field: 'name', op: 'NOT_EMPTY' }], message: 'x' } })).rejects.toThrow();
  });

  it('API 密钥调用同样受约束；审计日志按对象筛选 / API keys and audit filter', async () => {
    await rule();
    const key = (await call(apiKeys.POST, { token: a.token, body: { name: '集成', userId: a.user.id } })).json.key;
    const r = await newDeal({ amount: '2000000' }, key);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe('请填写预计成交日');
    expect((await call(auditLogs.GET, { token: a.token, query: { entityType: 'validation' } })).json.items[0]).toMatchObject({ action: 'validation.create' });
  });

  it('50 条启用规则：校验 300 毫秒内 / 50 active rules', async () => {
    await prisma.validationRule.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({ organizationId: a.org.id, name: `r${i}`, entity: 'DEAL' as const, when: [{ field: 'name', op: 'CONTAINS', value: `x${i}` }], require: [{ field: 'description', op: 'NOT_EMPTY' }], message: `m${i}` })),
    });
    const t0 = Date.now();
    await assertValidRecord(a.org.id, 'DEAL', { name: '普通', description: null });
    expect(Date.now() - t0).toBeLessThan(300);
    // 批量写入的规则创建时间相同，同一时间的规则之间顺序不保证，比较排序后的结果 / same-time rules have no guaranteed order
    const err = await assertValidRecord(a.org.id, 'DEAL', { name: 'x1 x2', description: null }).catch((e: { details: { rule: string[] } }) => e);
    expect([...(err as { details: { rule: string[] } }).details.rule].sort()).toEqual(['m1', 'm2']);
  });

  it('演示数据：规则存在，全部演示商机都满足演示规则 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const list = await prisma.validationRule.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
    expect(list.map((r) => [r.name, r.isActive])).toEqual(DEMO_VALIDATION_RULES.map((r) => [r.name, true]));
    for (const d of await prisma.deal.findMany({ where: { organizationId: org.id } })) {
      await expect(assertValidRecord(org.id, 'DEAL', d), d.name).resolves.toBeUndefined();
    }
  });
});
