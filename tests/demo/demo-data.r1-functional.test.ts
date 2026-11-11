/**
 * 涡轮增压器演示数据 第一轮：功能测试（数量、标注、阶段/币种/负责人分布、联系人、跟进、日期、确定性）。
 * Turbocharger demo data round 1: functional tests.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME, DEMO_USERS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import { prisma } from '@/server/db';
import { resetDb } from '../helpers';

let orgId: string;
const data = buildDemoData();

beforeAll(async () => {
  await resetDb();
  await seedDemo();
  orgId = (await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } })).id;
});

describe('demo data R1', () => {
  it('写入数量与数据集一致，且数据量充足 / counts match the dataset and are substantial', async () => {
    const counts = {
      accounts: await prisma.account.count({ where: { organizationId: orgId } }),
      contacts: await prisma.contact.count({ where: { organizationId: orgId } }),
      leads: await prisma.lead.count({ where: { organizationId: orgId } }),
      deals: await prisma.deal.count({ where: { organizationId: orgId } }),
      activities: await prisma.activity.count({ where: { organizationId: orgId } }),
    };
    expect(counts).toEqual({
      accounts: data.accounts.length,
      contacts: data.accounts.reduce((n, a) => n + a.contacts.length, 0),
      leads: data.leads.length,
      deals: data.deals.length,
      activities: data.activities.length,
    });
    expect(counts.accounts).toBeGreaterThanOrEqual(30);
    expect(counts.leads).toBeGreaterThanOrEqual(45);
    expect(counts.deals).toBeGreaterThanOrEqual(45);
    expect(counts.activities).toBeGreaterThanOrEqual(120);
  });

  it('5 个演示账号角色正确且均标记为演示账号 / five demo users with correct roles', async () => {
    const users = await prisma.user.findMany({ where: { organizationId: orgId }, orderBy: { email: 'asc' } });
    expect(users.map((u) => [u.email, u.role, u.isDemo]).sort()).toEqual(DEMO_USERS.map((u) => [u.email, u.role, true]).sort());
  });

  it('所有客户、联系人、线索、商机、跟进名称都带【演示】/ every name is labelled 【演示】', async () => {
    const names = [
      ...(await prisma.account.findMany({ where: { organizationId: orgId }, select: { name: true } })),
      ...(await prisma.contact.findMany({ where: { organizationId: orgId }, select: { name: true } })),
      ...(await prisma.lead.findMany({ where: { organizationId: orgId }, select: { name: true } })),
      ...(await prisma.deal.findMany({ where: { organizationId: orgId }, select: { name: true } })),
    ].map((x) => x.name);
    const subjects = (await prisma.activity.findMany({ where: { organizationId: orgId }, select: { subject: true } })).map((x) => x.subject);
    for (const n of [...names, ...subjects]) expect(n.startsWith('【演示】')).toBe(true);
  });

  it('商机覆盖 6 个阶段、3 种币种、3 位负责人 / deals cover all stages, currencies and owners', async () => {
    const deals = await prisma.deal.findMany({ where: { organizationId: orgId }, include: { owner: { select: { name: true } } } });
    expect(new Set(deals.map((d) => d.stage)).size).toBe(6);
    expect([...new Set(deals.map((d) => d.currency))].sort()).toEqual(['CNY', 'EUR', 'USD']);
    expect([...new Set(deals.map((d) => d.owner?.name))].sort()).toEqual(['王芳', '郑经理', '陈静'].sort());
    for (const d of deals) expect(Number(d.amount)).toBeGreaterThan(0);
  });

  it('日期合理：进行中商机预计成交在未来，已结束的在过去 / open deals close in the future, closed ones in the past', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (const d of await prisma.deal.findMany({ where: { organizationId: orgId } })) {
      if (d.stage.startsWith('CLOSED')) expect(d.expectedCloseDate!.getTime()).toBeLessThan(today.getTime());
      else expect(d.expectedCloseDate!.getTime()).toBeGreaterThan(today.getTime());
    }
  });

  it('每个客户恰有 1 位主要联系人 / each account has exactly one primary contact', async () => {
    const accounts = await prisma.account.findMany({ where: { organizationId: orgId }, include: { contacts: true } });
    for (const a of accounts) {
      expect(a.contacts.length).toBeGreaterThanOrEqual(2);
      expect(a.contacts.filter((c) => c.isPrimary)).toHaveLength(1);
    }
  });

  it('跟进含已完成、待办与已逾期，并关联到商机/客户/线索 / activities include done, pending and overdue items', async () => {
    const acts = await prisma.activity.findMany({ where: { organizationId: orgId } });
    const now = Date.now();
    expect(acts.filter((a) => a.completed).length).toBeGreaterThan(50);
    expect(acts.filter((a) => !a.completed && a.dueAt && a.dueAt.getTime() > now).length).toBeGreaterThan(5);
    expect(acts.filter((a) => !a.completed && a.dueAt && a.dueAt.getTime() < now).length).toBeGreaterThan(3);
    expect(acts.filter((a) => a.dealId).length).toBeGreaterThan(80);
    expect(acts.filter((a) => a.leadId).length).toBeGreaterThan(20);
    for (const a of acts) expect(a.completed).toBe(a.completedAt !== null);
  });

  it('线索覆盖多种来源与状态（以展会为主）/ leads cover sources and statuses, mostly trade shows', async () => {
    const leads = await prisma.lead.findMany({ where: { organizationId: orgId } });
    const bySource = leads.reduce<Record<string, number>>((m, l) => ((m[l.source ?? ''] = (m[l.source ?? ''] ?? 0) + 1), m), {});
    expect(Object.keys(bySource).length).toBeGreaterThanOrEqual(5);
    expect(bySource.EXHIBITION).toBe(Math.max(...Object.values(bySource)));
    expect(new Set(leads.map((l) => l.status)).size).toBeGreaterThanOrEqual(4);
  });

  it('数据集生成是确定的 / the dataset is deterministic', () => {
    expect(JSON.stringify(buildDemoData())).toBe(JSON.stringify(data));
  });
});
