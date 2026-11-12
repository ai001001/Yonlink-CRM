/**
 * 销售报表：漏斗、按月赢单、负责人排行、线索来源转化、报价单状态。所有数字实时来自数据库，按组织隔离并遵循可见范围
 * （销售代表只统计自己负责的）。金额按币种分别统计，不做汇率换算。
 *
 * 统计口径 / Definitions
 * - 漏斗：进行中商机的当前阶段分布（不受时间段影响）/ funnel: current stages of open deals (not period-bound)
 * - 赢单/输单：预计成交日期在时间段内的已结束商机 / won/lost: closed deals whose expected close date is in the period
 * - 线索、报价单、跟进：创建时间在时间段内（UTC）/ leads, quotes, activities: created within the period (UTC)
 * - 赢单率 = 赢单数 ÷ (赢单数 + 输单数)；报价接受率 = 已接受 ÷ (已接受 + 已拒绝) / win and acceptance rates by count
 *
 * Sales reports: funnel, monthly wins, owner ranking, lead-source conversion and quote statuses. Live, scoped by
 * organization and visibility; amounts per currency without conversion.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { visible } from '../permissions';
import { CURRENCIES, dateOnly } from './deals';

const OPEN_STAGES = ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION'] as const;
const QUOTE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;
/** 时间段最多 24 个月 / the period spans at most 24 months */
const MAX_MONTHS = 24;

/** 报表查询参数 / Report query */
export const reportQuerySchema = z.strictObject({
  currency: z.enum(CURRENCIES).default('CNY'),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  ownerId: z.uuid().optional(),
});

/** 日期 → UTC 零点 / date → UTC midnight */
const day = (v: string) => new Date(`${v}T00:00:00Z`);
/** UTC 日期字符串 / UTC date string */
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 解析时间段：默认最近 12 个月（含本月）；结束不早于开始，最长 24 个月。
 * Resolve the period: defaults to the last 12 months including this one; to ≥ from; at most 24 months.
 */
export function resolvePeriod(from?: string, to?: string, now = new Date()) {
  const end = to ?? ymd(now);
  const e = day(end);
  const start = from ?? ymd(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 11, 1)));
  const s = day(start);
  if (s > e) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid period', { from: ['after_to'] });
  const months: string[] = [];
  const last = e.getUTCFullYear() * 12 + e.getUTCMonth();
  for (let m = s.getUTCFullYear() * 12 + s.getUTCMonth(); m <= last; m++) {
    if (months.length === MAX_MONTHS) throw new ApiError(400, 'VALIDATION_ERROR', 'Period too long', { to: ['max_24_months'] });
    months.push(`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`);
  }
  // 时间戳类数据按 [开始 00:00, 结束次日 00:00) 统计 / timestamps use [from 00:00, to + 1 day 00:00)
  return { from: start, to: end, months, start: s, endExclusive: new Date(e.getTime() + 86_400_000) };
}

/**
 * 比率（百分比，1 位小数）；分母为 0 时为 null。
 * Percentage with one decimal; null when the denominator is zero.
 */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** 十进制合计转字符串（保留 2 位）/ decimal sum → 2-dp string */
const money = (v: Prisma.Decimal | null | undefined) => (v ?? new Prisma.Decimal(0)).toFixed(2);

/**
 * 生成销售报表。
 * Build the sales report.
 */
export async function salesReport(ctx: AuthContext, query: z.infer<typeof reportQuerySchema>) {
  const period = resolvePeriod(query.from, query.to);
  const org = ctx.organizationId;
  // 可见范围强制的负责人（销售代表）与筛选的负责人同时生效 / forced owner (sales reps) AND the requested owner
  const forced = visible(ctx).ownerId ?? null;
  const wanted = query.ownerId ?? null;
  const owner: Prisma.DealWhereInput = { AND: [forced ? { ownerId: forced } : {}, wanted ? { ownerId: wanted } : {}] };
  const ownerOf = owner as Prisma.LeadWhereInput & Prisma.ActivityWhereInput;
  const deal = { organizationId: org, currency: query.currency, ...owner };
  const created = { gte: period.start, lt: period.endExclusive };
  const closeDate = { gte: period.start, lt: period.endExclusive };

  const [pipeline, closed, monthly, openByOwner, closedByOwner, activities, leadsBySource, quotes, currencies] = await Promise.all([
    prisma.deal.groupBy({ by: ['stage'], where: { ...deal, stage: { in: [...OPEN_STAGES] } }, _count: { _all: true }, _sum: { amount: true }, orderBy: { stage: 'asc' } }),
    prisma.deal.groupBy({
      by: ['stage'],
      where: { ...deal, stage: { in: ['CLOSED_WON', 'CLOSED_LOST'] }, expectedCloseDate: closeDate },
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: { stage: 'asc' },
    }),
    prisma.$queryRaw<{ month: string; stage: string; count: number; amount: string }[]>`
      SELECT to_char(expected_close_date, 'YYYY-MM') AS month, stage::text AS stage, count(*)::int AS count, sum(amount)::text AS amount
      FROM deals
      WHERE organization_id = ${org}::uuid AND currency = ${query.currency}
        AND stage IN ('CLOSED_WON', 'CLOSED_LOST')
        AND expected_close_date >= ${period.from}::date AND expected_close_date <= ${period.to}::date
        AND (${forced}::uuid IS NULL OR owner_id = ${forced}::uuid)
        AND (${wanted}::uuid IS NULL OR owner_id = ${wanted}::uuid)
      GROUP BY 1, 2`,
    prisma.deal.groupBy({ by: ['ownerId'], where: { ...deal, stage: { in: [...OPEN_STAGES] } }, _count: { _all: true }, _sum: { amount: true }, orderBy: { ownerId: 'asc' } }),
    prisma.deal.groupBy({
      by: ['ownerId', 'stage'],
      where: { ...deal, stage: { in: ['CLOSED_WON', 'CLOSED_LOST'] }, expectedCloseDate: closeDate },
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ ownerId: 'asc' }, { stage: 'asc' }],
    }),
    prisma.activity.groupBy({ by: ['ownerId'], where: { organizationId: org, createdAt: created, ...ownerOf }, _count: { _all: true }, orderBy: { ownerId: 'asc' } }),
    prisma.lead.groupBy({ by: ['source', 'status'], where: { organizationId: org, createdAt: created, ...ownerOf }, _count: { _all: true }, orderBy: [{ source: 'asc' }, { status: 'asc' }] }),
    prisma.quote.groupBy({
      by: ['status'],
      where: { organizationId: org, currency: query.currency, createdAt: created, deal: owner },
      _count: { _all: true },
      _sum: { total: true },
      orderBy: { status: 'asc' },
    }),
    prisma.deal.groupBy({ by: ['currency'], where: { organizationId: org, ...owner }, _count: { _all: true }, orderBy: { currency: 'asc' } }),
  ]);

  const count = (r: { _count?: { _all?: number } | true }) => (typeof r._count === 'object' ? (r._count._all ?? 0) : 0);

  // 漏斗（补零）/ funnel (zero-filled)
  const funnel = OPEN_STAGES.map((stage) => {
    const r = pipeline.find((p) => p.stage === stage);
    return { stage, count: r ? count(r) : 0, amount: money(r?._sum.amount) };
  });
  const won = closed.find((c) => c.stage === 'CLOSED_WON');
  const lost = closed.find((c) => c.stage === 'CLOSED_LOST');
  const wonCount = won ? count(won) : 0;
  const lostCount = lost ? count(lost) : 0;

  // 按月（补零）/ monthly (zero-filled)
  const months = period.months.map((month) => {
    const w = monthly.find((m) => m.month === month && m.stage === 'CLOSED_WON');
    const l = monthly.find((m) => m.month === month && m.stage === 'CLOSED_LOST');
    return { month, wonCount: w?.count ?? 0, wonAmount: money(w ? new Prisma.Decimal(w.amount) : null), lostCount: l?.count ?? 0 };
  });

  // 负责人排行 / owner ranking
  const ownerIds = new Set<string | null>([...openByOwner.map((o) => o.ownerId), ...closedByOwner.map((o) => o.ownerId), ...activities.map((a) => a.ownerId)]);
  const users = await prisma.user.findMany({ where: { organizationId: org, id: { in: [...ownerIds].filter((v): v is string => !!v) } }, select: { id: true, name: true } });
  const owners = [...ownerIds]
    .map((id) => {
      const open = openByOwner.find((o) => o.ownerId === id);
      const w = closedByOwner.find((o) => o.ownerId === id && o.stage === 'CLOSED_WON');
      const l = closedByOwner.find((o) => o.ownerId === id && o.stage === 'CLOSED_LOST');
      const a = activities.find((x) => x.ownerId === id);
      const wc = w ? count(w) : 0;
      const lc = l ? count(l) : 0;
      return {
        ownerId: id,
        name: users.find((u) => u.id === id)?.name ?? null,
        openCount: open ? count(open) : 0,
        openAmount: money(open?._sum.amount),
        wonCount: wc,
        wonAmount: money(w?._sum.amount),
        lostCount: lc,
        winRate: rate(wc, wc + lc),
        activities: a ? count(a) : 0,
      };
    })
    .sort((x, y) => new Prisma.Decimal(y.wonAmount).comparedTo(x.wonAmount) || new Prisma.Decimal(y.openAmount).comparedTo(x.openAmount) || y.activities - x.activities);

  // 线索来源 / lead sources
  const sources = new Map<string | null, { total: number; converted: number }>();
  for (const r of leadsBySource) {
    const s = sources.get(r.source) ?? { total: 0, converted: 0 };
    s.total += count(r);
    if (r.status === 'CONVERTED') s.converted += count(r);
    sources.set(r.source, s);
  }
  const bySource = [...sources.entries()].map(([source, v]) => ({ source, ...v, conversionRate: rate(v.converted, v.total) })).sort((x, y) => y.total - x.total);
  const leadTotal = bySource.reduce((s, v) => s + v.total, 0);
  const leadConverted = bySource.reduce((s, v) => s + v.converted, 0);

  // 报价单 / quotes
  const quoteRows = QUOTE_STATUSES.map((status) => {
    const r = quotes.find((q) => q.status === status);
    return { status, count: r ? count(r) : 0, amount: money(r?._sum.total) };
  });
  const accepted = quoteRows.find((q) => q.status === 'ACCEPTED')!.count;
  const rejected = quoteRows.find((q) => q.status === 'REJECTED')!.count;

  const openCount = funnel.reduce((s, f) => s + f.count, 0);
  const openAmount = funnel.reduce((s, f) => s.plus(f.amount), new Prisma.Decimal(0));

  return {
    currency: query.currency,
    from: period.from,
    to: period.to,
    currencies: currencies.map((c) => c.currency),
    summary: {
      openCount,
      openAmount: money(openAmount),
      wonCount,
      wonAmount: money(won?._sum.amount),
      lostCount,
      lostAmount: money(lost?._sum.amount),
      winRate: rate(wonCount, wonCount + lostCount),
      leadTotal,
      leadConverted,
      leadConversionRate: rate(leadConverted, leadTotal),
      quoteAcceptanceRate: rate(accepted, accepted + rejected),
    },
    funnel,
    monthly: months,
    owners,
    leadSources: bySource,
    quotes: quoteRows,
  };
}
