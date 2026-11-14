/**
 * 应收账款报表（参考 Zoho 的应收账龄报表）：按币种统计未付清发票的未收金额与账龄，按客户汇总，列出未收发票。
 * 实时来自数据库，按组织隔离并遵循可见范围（销售代表只统计自己负责商机的发票）；不做汇率换算。
 *
 * 统计口径 / Definitions
 * - 未收：状态为未付款、部分付款的发票的“总计 − 已收”；已作废、已付清的不计 / outstanding = total − paid of unpaid
 *   and partially paid invoices; void and paid ones are excluded
 * - 逾期天数 = 今天（UTC 日期）− 到期日；≤ 0 为未到期 / days overdue = today (UTC) − due date; ≤ 0 is current
 * - 账龄：未到期、逾期 1–30、31–60、61–90、90 天以上 / buckets: current, 1–30, 31–60, 61–90, 90+ days overdue
 * - 近 30 天收款：收款日期在今天及之前 29 天内的收款合计 / collected: payments dated within the last 30 days
 *
 * Accounts receivable report: outstanding balances and aging of open invoices per currency, grouped by account,
 * with the open invoices listed. Live, organization-scoped and visibility-aware; no currency conversion.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { InvoiceStatus } from '@/generated/prisma/enums';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { visible } from '../permissions';
import { CURRENCIES } from './deals';
import { todayUtc } from './invoices';

/** 账龄分段 / aging buckets */
export const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type Bucket = (typeof BUCKETS)[number];
/** 收款统计天数 / collection window in days */
export const COLLECTED_DAYS = 30;
/** 明细最多返回的发票数 / max invoices listed */
export const INVOICE_LIMIT = 500;

/** 查询参数 / Query */
export const receivablesQuerySchema = z.strictObject({
  currency: z.enum(CURRENCIES).default('CNY'),
  ownerId: z.uuid().optional(),
});

const DAY = 86_400_000;

/**
 * 逾期天数（未到期为 0 或负数）。
 * Days overdue (zero or negative when not yet due).
 */
export function daysOverdue(dueDate: Date, today: Date): number {
  return Math.round((today.getTime() - dueDate.getTime()) / DAY);
}

/**
 * 按逾期天数划分账龄。
 * Aging bucket for a number of days overdue.
 */
export function agingBucket(days: number): Bucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

const zero = () => new Prisma.Decimal(0);
const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b, zero()])) as Record<Bucket, Prisma.Decimal>;
const fmtBuckets = (b: Record<Bucket, Prisma.Decimal>) => Object.fromEntries(BUCKETS.map((k) => [k, b[k].toFixed(2)])) as Record<Bucket, string>;

/**
 * 生成应收账款报表。
 * Build the accounts receivable report.
 * @param now 统计时间（测试用）/ reference time (for tests)
 * @param limit 明细最多返回的发票数 / max invoices listed
 */
export async function receivablesReport(ctx: AuthContext, query: z.infer<typeof receivablesQuerySchema>, now = new Date(), limit = INVOICE_LIMIT) {
  const today = todayUtc(now);
  // 可见范围强制的负责人（销售代表）与筛选的负责人同时生效 / forced owner (sales reps) AND the requested owner
  const forced = visible(ctx).ownerId ?? null;
  const deal: Prisma.DealWhereInput = { AND: [forced ? { ownerId: forced } : {}, query.ownerId ? { ownerId: query.ownerId } : {}] };
  const open: Prisma.InvoiceWhereInput = { organizationId: ctx.organizationId, deal, status: { in: [InvoiceStatus.UNPAID, InvoiceStatus.PARTIALLY_PAID] } };

  const [rows, currencies, collected] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...open, currency: query.currency },
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        paidAmount: true,
        invoiceDate: true,
        dueDate: true,
        deal: { select: { owner: { select: { id: true, name: true } }, account: { select: { id: true, name: true } } } },
      },
      orderBy: [{ dueDate: 'asc' }, { invoiceNumber: 'asc' }],
    }),
    prisma.invoice.groupBy({ by: ['currency'], where: open, orderBy: { currency: 'asc' } }),
    prisma.invoicePayment.aggregate({
      where: {
        organizationId: ctx.organizationId,
        paidOn: { gte: new Date(today.getTime() - (COLLECTED_DAYS - 1) * DAY), lte: today },
        invoice: { currency: query.currency, deal },
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const buckets = emptyBuckets();
  const bucketCounts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  const accounts = new Map<string, { accountId: string; name: string; count: number; outstanding: Prisma.Decimal; buckets: Record<Bucket, Prisma.Decimal>; oldestDueDate: Date; maxDaysOverdue: number }>();
  let outstanding = zero();
  let overdue = zero();
  let overdueCount = 0;
  const invoices = rows.map((r) => {
    const balance = r.total.minus(r.paidAmount);
    const days = daysOverdue(r.dueDate, today);
    const bucket = agingBucket(days);
    outstanding = outstanding.plus(balance);
    buckets[bucket] = buckets[bucket].plus(balance);
    bucketCounts[bucket] += 1;
    if (days > 0) {
      overdue = overdue.plus(balance);
      overdueCount += 1;
    }
    const acc = r.deal.account;
    const a = accounts.get(acc.id) ?? { accountId: acc.id, name: acc.name, count: 0, outstanding: zero(), buckets: emptyBuckets(), oldestDueDate: r.dueDate, maxDaysOverdue: days };
    a.count += 1;
    a.outstanding = a.outstanding.plus(balance);
    a.buckets[bucket] = a.buckets[bucket].plus(balance);
    if (r.dueDate < a.oldestDueDate) a.oldestDueDate = r.dueDate;
    a.maxDaysOverdue = Math.max(a.maxDaysOverdue, days);
    accounts.set(acc.id, a);
    return {
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      account: acc,
      owner: r.deal.owner,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      total: r.total.toFixed(2),
      balance: balance.toFixed(2),
      daysOverdue: Math.max(0, days),
      bucket,
    };
  });

  return {
    currency: query.currency,
    asOf: today.toISOString().slice(0, 10),
    currencies: currencies.map((c) => c.currency),
    summary: {
      outstanding: outstanding.toFixed(2),
      outstandingCount: rows.length,
      overdue: overdue.toFixed(2),
      overdueCount,
      collected: (collected._sum.amount ?? zero()).toFixed(2),
      collectedCount: collected._count._all,
    },
    buckets: BUCKETS.map((b) => ({ bucket: b, count: bucketCounts[b], amount: buckets[b].toFixed(2) })),
    // 欠款最多的客户在前 / largest balances first
    accounts: [...accounts.values()]
      .sort((x, y) => y.outstanding.comparedTo(x.outstanding) || x.name.localeCompare(y.name))
      .map((a) => ({ ...a, outstanding: a.outstanding.toFixed(2), buckets: fmtBuckets(a.buckets), oldestDueDate: a.oldestDueDate.toISOString().slice(0, 10), maxDaysOverdue: Math.max(0, a.maxDaysOverdue) })),
    // 最早到期的在前；超过上限时截断 / earliest due first; truncated beyond the limit
    invoices: invoices.slice(0, limit),
    truncated: invoices.length > limit,
  };
}
