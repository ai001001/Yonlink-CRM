/**
 * 工作台统计与全局搜索。所有数字均实时来自数据库，并按组织隔离。
 * Dashboard statistics and global search. All figures come live from the database, scoped by organization.
 */
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { containsText } from '../validation';
import { activityInclude } from './activities';

const CLOSED = ['CLOSED_WON', 'CLOSED_LOST'] as const;

/** 金额合计 / Amount total */
interface Sum {
  currency: string;
  amount: string;
}

/**
 * 把 groupBy 结果转换为十进制字符串合计。
 * Convert groupBy rows into decimal-string sums.
 */
function toSums(rows: { currency: string; _sum: { amount: { toString(): string } | null } | undefined }[]): Sum[] {
  return rows.map((r) => ({ currency: r.currency, amount: (r._sum?.amount ?? 0).toString() }));
}

/**
 * 工作台数据：客户/线索/商机数量，商机金额（全部、进行中、赢单，按币种），阶段分布，最近跟进，我的待办。
 * Dashboard data: counts, deal amounts (all / open / won per currency), stage breakdown,
 * recent activities and my pending items.
 */
export async function getDashboard(ctx: AuthContext) {
  const org = ctx.organizationId;
  const now = new Date();
  const [accounts, leads, deals, all, open, won, byStage, recentActivities, myTodos, myTodoCount, myOverdueCount] = await prisma.$transaction([
    prisma.account.count({ where: { organizationId: org } }),
    prisma.lead.count({ where: { organizationId: org } }),
    prisma.deal.count({ where: { organizationId: org } }),
    prisma.deal.groupBy({ by: ['currency'], where: { organizationId: org }, _sum: { amount: true }, orderBy: { currency: 'asc' } }),
    prisma.deal.groupBy({
      by: ['currency'],
      where: { organizationId: org, stage: { notIn: [...CLOSED] } },
      _sum: { amount: true },
      orderBy: { currency: 'asc' },
    }),
    prisma.deal.groupBy({
      by: ['currency'],
      where: { organizationId: org, stage: 'CLOSED_WON' },
      _sum: { amount: true },
      orderBy: { currency: 'asc' },
    }),
    prisma.deal.groupBy({
      by: ['stage', 'currency'],
      where: { organizationId: org },
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ stage: 'asc' }, { currency: 'asc' }],
    }),
    prisma.activity.findMany({
      where: { organizationId: org },
      include: activityInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 10,
    }),
    prisma.activity.findMany({
      where: { organizationId: org, ownerId: ctx.userId, completed: false },
      include: activityInclude,
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 10,
    }),
    prisma.activity.count({ where: { organizationId: org, ownerId: ctx.userId, completed: false } }),
    prisma.activity.count({ where: { organizationId: org, ownerId: ctx.userId, completed: false, dueAt: { lt: now } } }),
  ]);

  return {
    counts: { accounts, leads, deals },
    dealAmounts: { all: toSums(all), open: toSums(open), won: toSums(won) },
    stages: byStage.map((s) => ({
      stage: s.stage,
      currency: s.currency,
      count: (s._count as { _all: number } | undefined)?._all ?? 0,
      amount: (s._sum?.amount ?? 0).toString(),
    })),
    recentActivities,
    myTodos,
    myTodoCount,
    myOverdueCount,
  };
}

/** 全局搜索参数 / Global search query */
export const searchSchema = z.object({ q: z.string().trim().min(1).max(100) });

/**
 * 跨线索、客户（含联系人姓名）、商机搜索，每类最多 10 条。
 * Search across leads, accounts (including contact names) and deals, up to 10 each.
 */
export async function globalSearch(ctx: AuthContext, q: string) {
  const org = ctx.organizationId;
  const c = containsText(q);
  const [leads, accounts, deals] = await prisma.$transaction([
    prisma.lead.findMany({
      where: { organizationId: org, OR: [{ name: c }, { company: c }, { email: c }, { phone: c }, { mobile: c }] },
      select: { id: true, name: true, company: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.account.findMany({
      where: { organizationId: org, OR: [{ name: c }, { phone: c }, { contacts: { some: { name: c } } }] },
      select: { id: true, name: true, industry: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.deal.findMany({
      where: { organizationId: org, OR: [{ name: c }, { account: { name: c } }] },
      select: { id: true, name: true, stage: true, amount: true, currency: true, account: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);
  return { leads, accounts, deals };
}
