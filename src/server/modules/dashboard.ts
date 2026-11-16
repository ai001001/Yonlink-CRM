/**
 * 工作台统计与全局搜索。所有数字均实时来自数据库，并按组织隔离。
 * Dashboard statistics and global search. All figures come live from the database, scoped by organization.
 */
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { visible } from '../permissions';
import { containsText } from '../validation';
import { activityInclude } from './activities';
import { getLayout, type DashboardWidget } from './dashboard-layout';
import { sweepEscalations } from './ticket-sla';
import { OPEN_STATUSES } from './tickets';

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

/** 即将成交的天数窗口 / closing-soon window in days */
export const CLOSING_SOON_DAYS = 30;

/**
 * 工作台数据：只计算当前用户布局中显示的卡片（隐藏的卡片对应字段为 null）。
 * 卡片：数量、商机金额（全部、进行中、赢单，按币种）、我的待办、我的待处理工单（未解决、紧急在前）、最近跟进、即将成交（30 天内预计成交、含已逾期的进行中商机）、阶段分布。
 * Dashboard data: only the cards in the user's layout are computed (hidden cards come back as null).
 * Cards: counts, deal amounts (all / open / won per currency), my to-dos, my pending tickets (unresolved, urgent first), recent activities, closing soon
 * (open deals expected to close within 30 days, overdue included) and the stage breakdown.
 */
export async function getDashboard(ctx: AuthContext) {
  // 统计与搜索遵循可见范围（销售代表只统计自己负责的）/ figures and search follow visibility
  const scope = visible(ctx);
  const now = new Date();
  const layout = await getLayout(ctx);
  if (layout.widgets.includes('myTickets')) await sweepEscalations(ctx.organizationId);
  const on = (w: DashboardWidget) => layout.widgets.includes(w);
  const todoWhere = { ...scope, ownerId: ctx.userId, completed: false };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const soonWhere = { ...scope, stage: { notIn: [...CLOSED] }, expectedCloseDate: { lte: new Date(today.getTime() + CLOSING_SOON_DAYS * 86_400_000) } };
  const sumBy = (where: object) => prisma.deal.groupBy({ by: ['currency'], where, _sum: { amount: true }, orderBy: { currency: 'asc' } });

  // 我的待处理工单：负责人是我且未解决 / my pending tickets: owned by me and unresolved
  const ticketWhere = { ...scope, ownerId: ctx.userId, status: { in: OPEN_STATUSES } };

  const [counts, dealAmounts, todos, recentActivities, closingSoon, byStage, tickets] = await Promise.all([
    on('counts') ? Promise.all([prisma.account.count({ where: scope }), prisma.lead.count({ where: scope }), prisma.deal.count({ where: scope })]) : null,
    on('dealAmounts') ? Promise.all([sumBy(scope), sumBy({ ...scope, stage: { notIn: [...CLOSED] } }), sumBy({ ...scope, stage: 'CLOSED_WON' })]) : null,
    on('myTodos')
      ? Promise.all([
          prisma.activity.findMany({ where: todoWhere, include: activityInclude, orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }], take: 10 }),
          prisma.activity.count({ where: todoWhere }),
          prisma.activity.count({ where: { ...todoWhere, dueAt: { lt: now } } }),
        ])
      : null,
    on('recentActivities') ? prisma.activity.findMany({ where: scope, include: activityInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 10 }) : null,
    on('closingSoon')
      ? Promise.all([
          prisma.deal.findMany({
            where: soonWhere,
            select: { id: true, name: true, amount: true, currency: true, stage: true, expectedCloseDate: true, account: { select: { id: true, name: true } }, owner: { select: { id: true, name: true } } },
            orderBy: [{ expectedCloseDate: 'asc' }, { id: 'asc' }],
            take: 10,
          }),
          prisma.deal.count({ where: soonWhere }),
        ])
      : null,
    on('stages')
      ? prisma.deal.groupBy({ by: ['stage', 'currency'], where: scope, _count: { _all: true }, _sum: { amount: true }, orderBy: [{ stage: 'asc' }, { currency: 'asc' }] })
      : null,
    on('myTickets')
      ? Promise.all([
          prisma.ticket.findMany({
            where: ticketWhere,
            select: { id: true, ticketNumber: true, subject: true, status: true, priority: true, dueAt: true, escalatedAt: true, account: { select: { id: true, name: true } } },
            // 枚举按声明顺序排序（LOW < … < URGENT），降序即紧急在前 / enums sort in declaration order, so desc puts URGENT first
            orderBy: [{ priority: 'desc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
            take: 10,
          }),
          prisma.ticket.count({ where: ticketWhere }),
          prisma.ticket.count({ where: { ...ticketWhere, dueAt: { lt: now } } }),
        ])
      : null,
  ]);

  return {
    layout: layout.widgets,
    counts: counts && { accounts: counts[0], leads: counts[1], deals: counts[2] },
    dealAmounts: dealAmounts && { all: toSums(dealAmounts[0]), open: toSums(dealAmounts[1]), won: toSums(dealAmounts[2]) },
    stages:
      byStage?.map((s) => ({
        stage: s.stage,
        currency: s.currency,
        count: (s._count as { _all: number } | undefined)?._all ?? 0,
        amount: (s._sum?.amount ?? 0).toString(),
      })) ?? null,
    recentActivities,
    myTodos: todos?.[0] ?? null,
    myTodoCount: todos?.[1] ?? null,
    myOverdueCount: todos?.[2] ?? null,
    closingSoon: closingSoon && { items: closingSoon[0], total: closingSoon[1], days: CLOSING_SOON_DAYS },
    myTickets: tickets && { items: tickets[0].map((tk) => ({ ...tk, overdue: !!tk.dueAt && tk.dueAt < now })), total: tickets[1], overdue: tickets[2] },
  };
}

/** 全局搜索参数 / Global search query */
export const searchSchema = z.object({ q: z.string().trim().min(1).max(100) });

/**
 * 跨线索、客户（含联系人姓名）、商机搜索，每类最多 10 条。
 * Search across leads, accounts (including contact names) and deals, up to 10 each.
 */
export async function globalSearch(ctx: AuthContext, q: string) {
  // 统计与搜索遵循可见范围（销售代表只统计自己负责的）/ figures and search follow visibility
  const scope = visible(ctx);
  const c = containsText(q);
  const [leads, accounts, deals] = await prisma.$transaction([
    prisma.lead.findMany({
      where: { ...scope, OR: [{ name: c }, { company: c }, { email: c }, { phone: c }, { mobile: c }] },
      select: { id: true, name: true, company: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.account.findMany({
      where: { ...scope, OR: [{ name: c }, { phone: c }, { contacts: { some: { name: c } } }] },
      select: { id: true, name: true, industry: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.deal.findMany({
      where: { ...scope, OR: [{ name: c }, { account: { name: c } }] },
      select: { id: true, name: true, stage: true, amount: true, currency: true, account: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);
  return { leads, accounts, deals };
}
