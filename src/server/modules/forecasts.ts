/**
 * 销售目标与预测（参考 Zoho Forecasts）。
 * - 目标：负责人 × 月份 × 币种；管理员、经理（forecast.manage）设定，写审计；季度目标为三个月之和。
 * - 统计口径（与报表一致）：赢单与在手商机按“预计成交日期”落在期间内；金额按所选币种，不做汇率换算。
 * - 加权预测 = Σ 进行中商机金额 × 阶段赢单概率；预测 = 已赢单 + 加权预测；最好情况 = 已赢单 + 全部在手商机。
 * - 可见范围：销售代表只看到自己一行；其他角色看到全部（未停用的非只读用户、本期有目标或商机的用户、未分配商机）。
 * Sales targets and forecasts (cf. Zoho Forecasts): monthly targets per owner and currency set by admins and managers;
 * won and open deals by expected close date in the period; weighted = Σ open amount × stage probability;
 * forecast = won + weighted; best case = won + all open; sales reps see only their own row.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { can, requirePermission, visible } from '../permissions';
import { amountSchema, CURRENCIES } from './deals';
import { rate } from './reports';

/** 阶段赢单概率（%）/ stage win probabilities (%) */
export const STAGE_PROBABILITY = { QUALIFICATION: 10, NEEDS_ANALYSIS: 20, PROPOSAL: 40, NEGOTIATION: 70 } as const;
type OpenStage = keyof typeof STAGE_PROBABILITY;
const OPEN_STAGES = Object.keys(STAGE_PROBABILITY) as OpenStage[];

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER = /^(\d{4})-Q([1-4])$/;

/** 预测查询 / forecast query */
export const forecastQuerySchema = z.strictObject({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/, 'Invalid period')
    .optional(),
  currency: z.enum(CURRENCIES).default('CNY'),
});

/** 设定目标（amount 为 null 表示清除）/ set a target (null amount clears it) */
export const targetSchema = z.strictObject({
  userId: z.uuid(),
  month: z.string().regex(MONTH, 'Invalid month'),
  currency: z.enum(CURRENCIES),
  amount: amountSchema.nullable(),
});

/**
 * 解析期间：月（YYYY-MM）或季度（YYYY-Qn）；缺省为当前月（UTC）。
 * Resolve a period: a month (YYYY-MM) or a quarter (YYYY-Qn); defaults to the current month (UTC).
 */
export function resolveForecastPeriod(period?: string, now = new Date()) {
  const value = period ?? now.toISOString().slice(0, 7);
  let year: number;
  let first: number;
  let count: number;
  const m = MONTH.exec(value);
  const q = QUARTER.exec(value);
  if (m) [year, first, count] = [Number(m[1]), Number(m[2]) - 1, 1];
  else if (q) [year, first, count] = [Number(q[1]), (Number(q[2]) - 1) * 3, 3];
  else throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid period', { period: ['invalid'] });
  const months = Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, first + i, 1)));
  return { period: value, kind: m ? ('month' as const) : ('quarter' as const), months, start: months[0]!, endExclusive: new Date(Date.UTC(year, first + count, 1)) };
}

const zero = () => new Prisma.Decimal(0);
const money = (d: Prisma.Decimal) => d.toFixed(2);

/** 一行预测 / one forecast row */
interface Row {
  ownerId: string | null;
  name: string | null;
  target: Prisma.Decimal | null;
  won: Prisma.Decimal;
  wonCount: number;
  open: Prisma.Decimal;
  openCount: number;
  weighted: Prisma.Decimal;
}

/**
 * 行的输出格式（金额字符串、比率百分比）。
 * Output shape of a row (decimal strings, percentages).
 */
function present(r: Row) {
  const forecast = r.won.plus(r.weighted);
  const t = r.target;
  return {
    ownerId: r.ownerId,
    name: r.name,
    target: t ? money(t) : null,
    won: money(r.won),
    wonCount: r.wonCount,
    gap: t ? money(t.minus(r.won)) : null,
    attainment: t && t.gt(0) ? rate(r.won.toNumber(), t.toNumber()) : null,
    open: money(r.open),
    openCount: r.openCount,
    weighted: money(r.weighted),
    forecast: money(forecast),
    forecastAttainment: t && t.gt(0) ? rate(forecast.toNumber(), t.toNumber()) : null,
    bestCase: money(r.won.plus(r.open)),
  };
}

/**
 * 生成预测。
 * Build the forecast.
 */
export async function getForecast(ctx: AuthContext, query: z.infer<typeof forecastQuerySchema>) {
  const p = resolveForecastPeriod(query.period);
  const org = ctx.organizationId;
  const forced = visible(ctx).ownerId; // 销售代表只看自己 / sales reps see only themselves
  const ownerFilter = forced ? { ownerId: forced } : {};
  const closeDate = { gte: p.start, lt: p.endExclusive };
  const [targets, won, open] = await Promise.all([
    prisma.salesTarget.groupBy({
      by: ['userId'],
      where: { organizationId: org, currency: query.currency, month: { in: p.months }, ...(forced ? { userId: forced } : {}) },
      _sum: { amount: true },
      orderBy: { userId: 'asc' },
    }),
    prisma.deal.groupBy({
      by: ['ownerId'],
      where: { organizationId: org, currency: query.currency, stage: 'CLOSED_WON', expectedCloseDate: closeDate, ...ownerFilter },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { ownerId: 'asc' },
    }),
    prisma.deal.groupBy({
      by: ['ownerId', 'stage'],
      where: { organizationId: org, currency: query.currency, stage: { in: OPEN_STAGES }, expectedCloseDate: closeDate, ...ownerFilter },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: [{ ownerId: 'asc' }, { stage: 'asc' }],
    }),
  ]);
  // 参与统计的用户 / users in the forecast
  const ids = new Set<string>([...targets.map((x) => x.userId), ...won.flatMap((x) => (x.ownerId ? [x.ownerId] : [])), ...open.flatMap((x) => (x.ownerId ? [x.ownerId] : []))]);
  const users = await prisma.user.findMany({
    where: forced ? { id: forced, organizationId: org } : { organizationId: org, OR: [{ isActive: true, role: { not: 'READONLY' } }, { id: { in: [...ids] } }] },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const count = (x: { _count?: { _all?: number } | true }) => (typeof x._count === 'object' ? (x._count._all ?? 0) : 0);
  const build = (ownerId: string | null, name: string | null): Row => {
    const t = targets.find((x) => x.userId === ownerId);
    const w = won.find((x) => x.ownerId === ownerId);
    const o = open.filter((x) => x.ownerId === ownerId);
    return {
      ownerId,
      name,
      target: ownerId && t?._sum.amount ? t._sum.amount : null,
      won: w?._sum.amount ?? zero(),
      wonCount: w ? count(w) : 0,
      open: o.reduce((s, x) => s.plus(x._sum.amount ?? 0), zero()),
      openCount: o.reduce((s, x) => s + count(x), 0),
      weighted: o
        .reduce((s, x) => s.plus((x._sum.amount ?? zero()).mul(STAGE_PROBABILITY[x.stage as OpenStage]).div(100)), zero())
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    };
  };
  const rows = users.map((u) => build(u.id, u.name));
  // 未分配负责人的商机单列（无目标）/ deals without an owner get their own row (no target)
  if (!forced && (won.some((x) => !x.ownerId) || open.some((x) => !x.ownerId))) rows.push(build(null, null));
  const totals: Row = {
    ownerId: null,
    name: null,
    target: rows.some((r) => r.target) ? rows.reduce((s, r) => s.plus(r.target ?? 0), zero()) : null,
    won: rows.reduce((s, r) => s.plus(r.won), zero()),
    wonCount: rows.reduce((s, r) => s + r.wonCount, 0),
    open: rows.reduce((s, r) => s.plus(r.open), zero()),
    openCount: rows.reduce((s, r) => s + r.openCount, 0),
    weighted: rows.reduce((s, r) => s.plus(r.weighted), zero()),
  };
  return {
    period: p.period,
    kind: p.kind,
    months: p.months.map((m) => m.toISOString().slice(0, 7)),
    currency: query.currency,
    probabilities: STAGE_PROBABILITY,
    canEdit: can(ctx, 'forecast.manage') && p.kind === 'month',
    rows: rows.map(present),
    totals: present(totals),
  };
}

/**
 * 设定或清除目标（需 forecast.manage；负责人须为本组织用户），写审计。
 * Set or clear a target (forecast.manage; the owner must belong to the organization), audited.
 */
export async function setTarget(ctx: AuthContext, input: z.infer<typeof targetSchema>) {
  requirePermission(ctx, 'forecast.manage');
  const user = await prisma.user.findFirst({ where: { id: input.userId, organizationId: ctx.organizationId }, select: { id: true } });
  if (!user) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid owner', { userId: ['not_found'] });
  const month = new Date(`${input.month}-01T00:00:00Z`);
  const key = { organizationId_userId_month_currency: { organizationId: ctx.organizationId, userId: user.id, month, currency: input.currency } };
  return prisma.$transaction(async (tx) => {
    const before = await tx.salesTarget.findUnique({ where: key });
    const prev = before ? before.amount.toFixed(2) : null;
    let next: string | null = null;
    if (input.amount === null) {
      if (before) await tx.salesTarget.delete({ where: key });
    } else {
      const row = await tx.salesTarget.upsert({
        where: key,
        create: { organizationId: ctx.organizationId, userId: user.id, month, currency: input.currency, amount: input.amount, updatedById: ctx.userId },
        update: { amount: input.amount, updatedById: ctx.userId },
      });
      next = row.amount.toFixed(2);
    }
    if (prev !== next) {
      await audit(tx, {
        ...by(ctx),
        action: 'target.update',
        entityType: 'target',
        entityId: user.id,
        changes: { userId: user.id, month: input.month, currency: input.currency, fields: { amount: [prev, next] } },
      });
    }
    return { userId: user.id, month: input.month, currency: input.currency, amount: next };
  });
}
