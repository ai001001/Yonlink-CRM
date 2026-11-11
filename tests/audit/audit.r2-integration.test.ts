/**
 * 审计日志 第二轮：集成测试（事务一致性、只追加、脱敏、组织隔离、异常输入）。
 * Audit log round 2: integration tests (transactional consistency, append-only, redaction, isolation, bad input).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as activities from '@/app/api/activities/route';
import * as auditRoute from '@/app/api/audit-logs/route';
import * as loginRoute from '@/app/api/auth/login/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import { audit, mask } from '@/server/audit';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

describe('audit R2 transactional consistency', () => {
  it('业务失败不产生审计记录（校验失败、409、404）/ failed operations leave no audit rows', async () => {
    await call(leads.POST, { token: a.token, body: { name: '' } });
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    await call(deals.POST, { token: a.token, body: { name: 'd', accountId: acc.id } });
    expect((await call(accountItem.DELETE, { token: a.token, method: 'DELETE', params: { id: acc.id } })).status).toBe(409);
    await call(leadItem.DELETE, { token: a.token, method: 'DELETE', params: { id: '00000000-0000-4000-8000-000000000000' } });
    expect((await prisma.auditLog.findMany()).map((l) => l.action).sort()).toEqual(['account.create', 'deal.create']);
  });

  it('并发转化：只有一条 lead.convert，失败方的创建记录随事务回滚 / concurrent conversion audits only the winner', async () => {
    const lead = (await call(leads.POST, { token: a.token, body: { name: '张三' } })).json;
    await Promise.all(Array.from({ length: 3 }, () => call(convert.POST, { token: a.token, params: { id: lead.id }, body: { account: { mode: 'new' } } })));
    const count = (action: string) => prisma.auditLog.count({ where: { action } });
    expect(await count('lead.convert')).toBe(1);
    expect(await count('account.create')).toBe(1);
    expect(await count('contact.create')).toBe(1);
  });

  it('审计写入失败时业务写入一并回滚 / an audit failure rolls back the business write', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.lead.create({ data: { organizationId: a.org.id, name: '应回滚' } });
        // 其他组织的操作人违反复合外键 / actor from another org violates the composite FK
        await audit(tx, { organizationId: a.org.id, actorId: b.user.id, action: 'lead.create', entityType: 'lead' });
      }),
    ).rejects.toThrow();
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe('audit R2 append-only', () => {
  it('ORM 与原生 SQL 均无法修改或删除审计记录 / UPDATE and DELETE are rejected', async () => {
    await call(leads.POST, { token: a.token, body: { name: '张三' } });
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'lead.delete' } })).rejects.toThrow();
    await expect(prisma.auditLog.updateMany({ data: { actorId: null } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('UPDATE audit_logs SET changes = NULL')).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it('API 只提供查询，不提供修改/删除 / the API exposes no write methods', () => {
    expect(Object.keys(auditRoute).sort()).toEqual(['GET', 'OPTIONS']);
  });

  it('删除业务记录后其审计记录仍保留可查 / logs outlive deleted records', async () => {
    const lead = (await call(leads.POST, { token: a.token, body: { name: '张三' } })).json;
    await call(leadItem.DELETE, { token: a.token, method: 'DELETE', params: { id: lead.id } });
    const res = await call(auditRoute.GET, { token: a.token, query: { entityType: 'lead', entityId: lead.id } });
    expect(res.json.items.map((i: { action: string }) => i.action)).toEqual(['lead.delete', 'lead.create']);
  });
});

describe('audit R2 redaction', () => {
  it('打码规则 / masking rules', () => {
    expect(mask('zhangsan@example.com')).toBe('z***@example.com');
    expect(mask('13800001234')).toBe('138******34');
    expect(mask('1234')).toBe('****');
  });

  it('邮箱/电话打码，长文本不记原文，密码与令牌从不出现 / PII masked, long text redacted, secrets never stored', async () => {
    const secretText = '客户私下透露预算 300 万';
    const lead = (await call(leads.POST, {
      token: a.token,
      body: { name: '张三', email: 'zhangsan@example.com', mobile: '13800001234', phone: '021-55551234', description: secretText },
    })).json;
    await call(leadItem.PATCH, { token: a.token, method: 'PATCH', params: { id: lead.id }, body: { email: 'new.mail@example.org', description: `${secretText}（更新）` } });
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', address: '某市某路 88 号 1203 室', phone: '0571-88880000' } })).json;
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '陈', email: 'chen@corp.cn', phone: '13911112222' } });
    await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '电话', content: secretText, accountId: acc.id } });
    const login = await call(loginRoute.POST, { body: { email: a.user.email, password: a.password } });

    const dump = JSON.stringify(await prisma.auditLog.findMany());
    for (const raw of ['zhangsan@example.com', 'new.mail@example.org', '13800001234', '021-55551234', secretText, '1203 室', 'chen@corp.cn', '13911112222', '0571-88880000', a.password, login.json.token]) {
      expect(dump).not.toContain(raw);
    }
    const passwordHash = (await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).passwordHash;
    expect(dump).not.toContain(passwordHash);

    const create = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.create' } });
    expect(create.changes).toMatchObject({ after: { email: 'z***@example.com', mobile: '138******34', description: '[redacted]' } });
    const update = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.update' } });
    expect(update.changes).toEqual({ fields: { email: ['z***@example.com', 'n***@example.org'], description: ['[redacted]', '[redacted]'] } });
  });

  it('不存在的邮箱登录失败不写日志（无所属组织）/ unknown-email failures are not logged', async () => {
    await call(loginRoute.POST, { body: { email: 'ghost@yonlink.test', password: 'x' } });
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe('audit R2 isolation & input', () => {
  it('只能查询本组织审计记录 / logs are organization scoped', async () => {
    const leadB = (await call(leads.POST, { token: b.token, body: { name: 'B 线索' } })).json;
    await call(leads.POST, { token: a.token, body: { name: 'A 线索' } });
    const q = async (query: Record<string, string>) => (await call(auditRoute.GET, { token: a.token, query })).json;
    expect((await q({})).total).toBe(1);
    expect((await q({ entityId: leadB.id })).total).toBe(0);
    expect((await q({ actorId: b.user.id })).total).toBe(0);
    expect(JSON.stringify(await q({}))).not.toContain('B 线索');
  });

  it('未登录 401 / unauthenticated', async () => {
    expect((await call(auditRoute.GET)).status).toBe(401);
  });

  it.each([
    [{ entityType: 'session' }],
    [{ entityId: 'abc' }],
    [{ action: 'DROP TABLE' }],
    [{ action: 'lead' }],
    [{ actorId: '1' }],
    [{ from: 'yesterday' }],
    [{ to: '2027-01-01' }],
    [{ pageSize: '101' }],
    [{ q: 'x' }],
    [{ actor: '00000000-0000-4000-8000-000000000000' }],
  ])('非法查询 %j → 400', async (query) => {
    expect((await call(auditRoute.GET, { token: a.token, query })).status).toBe(400);
  });

  it('数据库复合外键阻止跨组织操作人 / composite FK blocks cross-org actor', async () => {
    await expect(
      prisma.auditLog.create({ data: { organizationId: a.org.id, actorId: b.user.id, action: 'lead.create', entityType: 'lead' } }),
    ).rejects.toThrow();
  });
});
