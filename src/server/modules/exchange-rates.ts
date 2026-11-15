/**
 * 汇率（参考 Zoho CRM Multi-Currency）：本币为人民币；每种外币按生效日期保存汇率历史（1 单位外币 = rate 人民币）。
 * - 查询某日汇率：取该日及之前最近生效的一条；本币汇率恒为 1；没有可用汇率时为 null（报表中列为“缺少汇率”）。
 * - 同一币种同一生效日期只有一条（再次录入即修改）；录入、修改、删除需 rate.manage（管理员）并写审计。
 * - 汇率变更不影响已开发票的汇率快照。
 * Exchange rates (cf. Zoho CRM multi-currency): the base currency is CNY; each foreign currency keeps dated rates
 * (1 unit = rate CNY). The rate for a day is the latest effective on or before it; the base rate is always 1; no
 * rate yields null (reported as missing). One rate per currency and date (re-entering updates it); changes need
 * rate.manage (admins) and are audited. Existing invoice snapshots are not affected.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { notFound } from '../errors';
import { requirePermission } from '../permissions';
import { CURRENCIES, dateOnly } from './deals';

/** 本币 / base currency */
export const BASE_CURRENCY = 'CNY' as const;
/** 可录汇率的外币 / foreign currencies that take rates */
export const FOREIGN_CURRENCIES = CURRENCIES.filter((c) => c !== BASE_CURRENCY) as Exclude<(typeof CURRENCIES)[number], 'CNY'>[];

/** 汇率：正数，整数最多 10 位、小数最多 8 位 / rate: positive, ≤ 10 integer and ≤ 8 decimal digits */
const rateValue = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,8})?$/, 'Invalid rate'))
  .refine((v) => Number(v) > 0, 'Rate must be positive');

/** 录入汇率（同币种同日期即修改）/ Enter a rate (same currency and date updates it) */
export const rateSaveSchema = z.strictObject({
  currency: z.enum(FOREIGN_CURRENCIES as [string, ...string[]]),
  rate: rateValue,
  effectiveDate: dateOnly.transform((v) => new Date(`${v}T00:00:00Z`)),
});

const select = {
  id: true,
  currency: true,
  rate: true,
  effectiveDate: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ExchangeRateSelect;

/** UTC 日期 / UTC date */
const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * 某日各外币的有效汇率（该日及之前最近生效的一条）；本币为 1。
 * Effective rates for a day (latest on or before it per currency); the base currency is 1.
 * @param client 事务或默认客户端 / transaction or default client
 */
export async function ratesOn(organizationId: string, date: Date, client: Prisma.TransactionClient = prisma): Promise<Map<string, Prisma.Decimal>> {
  const rows = await client.$queryRaw<{ currency: string; rate: Prisma.Decimal }[]>`
    SELECT DISTINCT ON (currency) currency, rate FROM exchange_rates
    WHERE organization_id = ${organizationId}::uuid AND effective_date <= ${day(date)}::date
    ORDER BY currency, effective_date DESC`;
  const map = new Map<string, Prisma.Decimal>(rows.map((r) => [r.currency, new Prisma.Decimal(r.rate)]));
  map.set(BASE_CURRENCY, new Prisma.Decimal(1));
  return map;
}

/**
 * 折合本币（保留 2 位，四舍五入）。
 * Convert to the base currency (2 decimals, half-up).
 */
export function toBase(amount: Prisma.Decimal | string, rate: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(amount).mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * 按币种的金额折合本币求和；没有汇率的币种列入 missing，不计入合计。
 * Sum per-currency amounts in the base currency; currencies without a rate go to `missing` and are excluded.
 */
export function sumInBase(amounts: Map<string, Prisma.Decimal>, rates: Map<string, Prisma.Decimal>) {
  let total = new Prisma.Decimal(0);
  const missing: string[] = [];
  for (const [currency, amount] of amounts) {
    if (amount.isZero()) continue;
    const rate = rates.get(currency);
    if (rate) total = total.plus(toBase(amount, rate));
    else missing.push(currency);
  }
  return { total: total.toFixed(2), missing: missing.sort() };
}

/**
 * 汇率页数据：今天各外币的当前汇率与全部历史（最新在前，最多 500 条）。
 * Rates page: today's current rate per foreign currency and the history (newest first, at most 500).
 */
export async function listRates(ctx: AuthContext, now = new Date()) {
  const [current, history] = await Promise.all([
    ratesOn(ctx.organizationId, now),
    prisma.exchangeRate.findMany({ where: { organizationId: ctx.organizationId }, select, orderBy: [{ effectiveDate: 'desc' }, { currency: 'asc' }], take: 500 }),
  ]);
  return {
    base: BASE_CURRENCY,
    asOf: day(now).toISOString().slice(0, 10),
    current: FOREIGN_CURRENCIES.map((c) => ({ currency: c, rate: current.get(c)?.toString() ?? null })),
    history,
  };
}

/**
 * 录入或修改汇率（同币种同生效日期为修改），写审计。
 * Enter or update a rate (same currency and date updates it); audited.
 */
export async function saveRate(ctx: AuthContext, input: z.infer<typeof rateSaveSchema>) {
  requirePermission(ctx, 'rate.manage');
  return prisma.$transaction(async (tx) => {
    const key = { organizationId_currency_effectiveDate: { organizationId: ctx.organizationId, currency: input.currency, effectiveDate: input.effectiveDate } };
    const before = await tx.exchangeRate.findUnique({ where: key, select: { rate: true } });
    const row = await tx.exchangeRate.upsert({
      where: key,
      create: { organizationId: ctx.organizationId, currency: input.currency, rate: input.rate, effectiveDate: input.effectiveDate, createdById: ctx.userId },
      update: { rate: input.rate },
      select,
    });
    const date = input.effectiveDate.toISOString().slice(0, 10);
    await audit(tx, {
      ...by(ctx),
      action: before ? 'rate.update' : 'rate.create',
      entityType: 'rate',
      entityId: row.id,
      changes: before
        ? { currency: input.currency, effectiveDate: date, fields: { rate: [before.rate.toString(), row.rate.toString()] } }
        : { currency: input.currency, effectiveDate: date, rate: row.rate.toString() },
    });
    return row;
  });
}

/**
 * 删除一条汇率（录错时使用），写审计；已开发票的快照不受影响。
 * Delete a rate (for mistakes); audited; existing invoice snapshots are unaffected.
 */
export async function deleteRate(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, 'rate.manage');
  await prisma.$transaction(async (tx) => {
    const row = await tx.exchangeRate.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!row) throw notFound();
    await tx.exchangeRate.delete({ where: { id } });
    await audit(tx, {
      ...by(ctx),
      action: 'rate.delete',
      entityType: 'rate',
      entityId: id,
      changes: { currency: row.currency, effectiveDate: row.effectiveDate.toISOString().slice(0, 10), rate: row.rate.toString() },
    });
  });
}
