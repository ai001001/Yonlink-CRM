/**
 * 涡轮增压器演示数据 第二轮：集成测试（重复执行/重建、旧组织改名且审计保留、只影响演示组织、角色可见范围、合计一致、无真实域名）。
 * Turbocharger demo data round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, demoDuplicates, DEMO_ORG_NAME, DEMO_USERS, LEGACY_DEMO_ORG_NAMES } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as board from '@/app/api/deals/board/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as leads from '@/app/api/leads/route';
import { hashToken } from '@/server/auth';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

const data = buildDemoData();
// 另外写入的演示重复记录（查重合并）/ demo duplicates written separately for deduplication
const dups = demoDuplicates(data);
const allLeads = [...data.leads, ...dups.leads];
const orgOf = () => prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
const count = async (organizationId: string) => ({
  accounts: await prisma.account.count({ where: { organizationId } }),
  leads: await prisma.lead.count({ where: { organizationId } }),
  deals: await prisma.deal.count({ where: { organizationId } }),
  activities: await prisma.activity.count({ where: { organizationId } }),
});

/** 以演示账号身份创建会话 / create a session for a demo user */
async function tokenFor(email: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = `t${Math.random().toString(36).slice(2)}${'x'.repeat(30)}`;
  await prisma.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return token;
}

beforeEach(resetDb);

describe('demo data R2 idempotency & reset', () => {
  it('不带 --reset 重复执行不会重复写入 / re-running without reset adds nothing', async () => {
    await seedDemo();
    const org = await orgOf();
    const before = await count(org.id);
    await seedDemo();
    expect(await count(org.id)).toEqual(before);
    expect(await prisma.user.count({ where: { organizationId: org.id } })).toBe(DEMO_USERS.length);
  });

  it('--reset 重建业务数据：数量不变、记录为新、账号保留 / reset regenerates data and keeps users', async () => {
    await seedDemo();
    const org = await orgOf();
    const oldIds = (await prisma.deal.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((d) => d.id);
    const userIds = (await prisma.user.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((u) => u.id).sort();
    await seedDemo({ reset: true });
    expect(await count(org.id)).toEqual({ accounts: data.accounts.length + dups.accounts.length, leads: allLeads.length, deals: data.deals.length, activities: data.activities.length });
    expect(await prisma.deal.count({ where: { id: { in: oldIds } } })).toBe(0);
    expect((await prisma.user.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((u) => u.id).sort()).toEqual(userIds);
  });

  it('旧演示组织改名复用，账号与审计日志保留，旧业务数据被替换 / legacy org renamed with users and audit kept', async () => {
    const legacy = await prisma.organization.create({ data: { name: LEGACY_DEMO_ORG_NAMES[0]! } });
    const user = await prisma.user.create({
      data: { organizationId: legacy.id, email: DEMO_USERS[2].email, name: DEMO_USERS[2].name, role: 'SALES', isDemo: true, passwordHash: 'x' },
    });
    await prisma.lead.create({ data: { organizationId: legacy.id, ownerId: user.id, name: '【演示】旧线索' } });
    await prisma.auditLog.create({ data: { organizationId: legacy.id, actorId: user.id, action: 'auth.demo_login', entityType: 'auth' } });
    await seedDemo({ reset: true });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(org.name).toBe(DEMO_ORG_NAME);
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.lead.count({ where: { name: '【演示】旧线索' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: legacy.id } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).organizationId).toBe(legacy.id);
  });

  it('重建只影响演示组织，其他组织数据不变 / reset touches the demo org only', async () => {
    const other = await createTenant('B');
    await prisma.lead.create({ data: { organizationId: other.org.id, name: '客户真实线索' } });
    await seedDemo();
    await seedDemo({ reset: true });
    expect(await prisma.lead.count({ where: { organizationId: other.org.id } })).toBe(1);
  });
});

describe('demo data R2 roles & consistency', () => {
  it('各角色看到的数量符合负责人分配 / counts per role follow ownership', async () => {
    await seedDemo();
    const owners = { sales1: 'sales1@demo.yonlink.test', sales2: 'sales2@demo.yonlink.test', manager: 'manager@demo.yonlink.test' } as const;
    for (const [key, email] of Object.entries(owners)) {
      const token = await tokenFor(email);
      const total = (await call(leads.GET, { token })).json.total;
      if (key === 'manager') expect(total).toBe(allLeads.length);
      else expect(total).toBe(allLeads.filter((l) => l.owner === key).length);
    }
    const viewer = await tokenFor('viewer@demo.yonlink.test');
    expect((await call(leads.GET, { token: viewer })).json.total).toBe(allLeads.length);
  });

  it('看板各列合计与数据集金额一致（按币种精确）/ board totals equal dataset amounts per currency', async () => {
    await seedDemo();
    const token = await tokenFor('manager@demo.yonlink.test');
    const b = (await call(board.GET, { token })).json;
    for (const col of b.columns as { stage: string; count: number; sums: { currency: string; amount: string }[] }[]) {
      const expected = data.deals.filter((d) => d.stage === col.stage);
      expect(col.count).toBe(expected.length);
      for (const s of col.sums) {
        const cents = expected.filter((d) => d.currency === s.currency).reduce((n, d) => n + Math.round(Number(d.amount) * 100), 0);
        expect(Math.round(Number(s.amount) * 100)).toBe(cents);
      }
    }
  });

  it('工作台：销售代表有待办与逾期提醒 / sales reps get to-dos and overdue items on the dashboard', async () => {
    await seedDemo();
    const totals = [];
    for (const email of ['sales1@demo.yonlink.test', 'sales2@demo.yonlink.test']) {
      const d = (await call(dashboard.GET, { token: await tokenFor(email) })).json;
      expect(d.myTodoCount).toBeGreaterThan(0);
      expect(d.recentActivities.length).toBe(10);
      totals.push(d.myOverdueCount);
    }
    expect(totals.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('不使用真实域名：网站与邮箱都是保留域名 / only reserved domains are used', async () => {
    await seedDemo();
    const org = await orgOf();
    const sites = (await prisma.account.findMany({ where: { organizationId: org.id }, select: { website: true } })).map((a) => a.website!);
    const emails = [
      ...(await prisma.contact.findMany({ where: { organizationId: org.id }, select: { email: true } })),
      ...(await prisma.lead.findMany({ where: { organizationId: org.id }, select: { email: true } })),
    ].map((x) => x.email!);
    for (const s of sites) expect(new URL(s).hostname.endsWith('.example')).toBe(true);
    for (const e of emails) expect(e).toMatch(/@[a-z0-9.-]+\.example$/i);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/jrone/i);
  });
});
