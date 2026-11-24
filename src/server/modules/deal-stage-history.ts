/**
 * 商机阶段历史（对标 Zoho Stage History）与阶段停留时长。
 * - 历史由数据库触发器在新建商机及阶段、金额、币种、预计成交日变化时写入，只增不改；修改人来自写入事务登记的操作人。
 *   变化时间取触发器执行时刻（行锁之后），并发修改同一商机时顺序与实际一致。
 * - 每条历史的停留时长 = 到下一条历史的时间；最新一条为进行中阶段时计到现在，已赢单/输单则不计。
 * - 可能性按阶段固定（与销售预测一致，赢单 100%、输单 0%），预期收入 = 金额 × 可能性。
 * - 阶段停留时长报表：连续相同阶段的历史合并为一段“停留”；统计时间段内开始且已结束的停留的平均天数，
 *   以及目前仍处于各阶段的商机已停留的平均天数；成交周期 = 首条历史到进入赢单/输单的天数（进入时间在时间段内）。
 *   遵循可见范围（销售代表只统计自己负责的），可按负责人筛选；所有币种一起统计（与金额无关）。
 * Deal stage history (cf. Zoho Stage History) and stage durations. History rows are written by a database trigger on
 * create and on stage, amount, currency or expected-close-date changes (append-only; the actor comes from the writing
 * transaction). A row's duration runs to the next row; the latest row counts to now while the deal is open and has no
 * duration once won or lost. Probability is fixed per stage (as in forecasts: won 100 %, lost 0 %); expected revenue =
 * amount × probability. The stage-duration report merges consecutive same-stage rows into stays: average days of
 * completed stays that started in the period, average days so far of deals currently in each stage, and the sales
 * cycle (first row → entering won/lost within the period). Visibility applies (sales reps see their own); filterable by
 * owner; all currencies together.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { notFound } from '../errors';
import { visible } from '../permissions';
import { readableDeals, territoryReadScope } from './territory-rules';
import { dateOnly } from './deals';
import { STAGE_PROBABILITY } from './forecasts';
import { resolvePeriod } from './reports';

/** 进行中阶段（按销售流程顺序）/ open stages in pipeline order */
export const OPEN_STAGES = ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION'] as const;
/** 各阶段可能性（%）/ probability per stage (%) */
export const PROBABILITY: Record<string, number> = { ...STAGE_PROBABILITY, CLOSED_WON: 100, CLOSED_LOST: 0 };
const CLOSED = new Set(['CLOSED_WON', 'CLOSED_LOST']);

/**
 * 商机的阶段历史（最新在前），附每条的停留时长、可能性、预期收入与修改人；商机不可见时 404。
 * A deal's stage history (newest first) with duration, probability, expected revenue and actor; 404 when not visible.
 */
export async function getStageHistory(ctx: AuthContext, dealId: string, now = new Date()) {
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id: dealId }, readableDeals(ctx, await territoryReadScope(ctx))] }, select: { id: true } });
  if (!deal) throw notFound();
  const rows = await prisma.dealStageHistory.findMany({
    where: { organizationId: ctx.organizationId, dealId },
    select: { id: true, stage: true, amount: true, currency: true, expectedCloseDate: true, changedAt: true, changedBy: { select: { id: true, name: true } } },
    orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
  });
  const items = rows.map((r, i) => {
    const next = rows[i + 1];
    const end = next ? next.changedAt : CLOSED.has(r.stage) ? null : now;
    const probability = PROBABILITY[r.stage]!;
    return {
      ...r,
      expectedCloseDate: r.expectedCloseDate?.toISOString().slice(0, 10) ?? null,
      stageChanged: i === 0 || rows[i - 1]!.stage !== r.stage,
      current: !next,
      durationMs: end ? Math.max(0, end.getTime() - r.changedAt.getTime()) : null,
      probability,
      expectedRevenue: r.amount.mul(probability).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2),
    };
  });
  return { items: items.reverse() };
}

/** 阶段停留时长报表查询 / stage duration report query */
export const stageDurationQuerySchema = z.strictObject({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  ownerId: z.uuid().optional(),
});

/** 天数（保留 1 位）/ days with one decimal */
const days = (seconds: number | null) => (seconds === null ? null : Math.round((seconds / 86400) * 10) / 10);

/**
 * 阶段停留时长报表。
 * Stage duration report.
 */
export async function stageDurationReport(ctx: AuthContext, query: z.infer<typeof stageDurationQuerySchema>, now = new Date()) {
  const period = resolvePeriod(query.from, query.to, now);
  const org = ctx.organizationId;
  // 可见范围强制的负责人与筛选的负责人同时生效 / forced owner (sales reps) AND the requested owner
  const forced = visible(ctx).ownerId ?? null;
  const wanted = query.ownerId ?? null;
  const ownerSql = Prisma.sql`${forced ? Prisma.sql`AND d.owner_id = ${forced}::uuid` : Prisma.empty} ${wanted ? Prisma.sql`AND d.owner_id = ${wanted}::uuid` : Prisma.empty}`;
  const rows = await prisma.$queryRaw<{ stage: string; kind: string; count: number; avg_seconds: number | null }[]>`
    WITH h AS (
      SELECT h.deal_id, h.stage, h.changed_at,
             lag(h.stage) OVER (PARTITION BY h.deal_id ORDER BY h.changed_at, h.id) AS prev
      FROM deal_stage_history h
      JOIN deals d ON d.id = h.deal_id AND d.organization_id = h.organization_id
      WHERE h.organization_id = ${org}::uuid ${ownerSql}
    ), stays AS (
      SELECT deal_id, stage, changed_at AS started_at,
             lead(changed_at) OVER (PARTITION BY deal_id ORDER BY changed_at) AS ended_at,
             min(changed_at) OVER (PARTITION BY deal_id) AS first_at
      FROM h WHERE prev IS DISTINCT FROM stage
    )
    SELECT stage::text AS stage, 'done' AS kind, count(*)::int AS count, avg(extract(epoch FROM ended_at - started_at))::float8 AS avg_seconds
      FROM stays WHERE ended_at IS NOT NULL AND started_at >= ${period.start} AND started_at < ${period.endExclusive}
        AND stage::text IN ('QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION')
      GROUP BY stage
    UNION ALL
    SELECT stage::text, 'current', count(*)::int, avg(extract(epoch FROM ${now}::timestamptz - started_at))::float8
      FROM stays WHERE ended_at IS NULL AND stage::text IN ('QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION')
      GROUP BY stage
    UNION ALL
    SELECT stage::text, 'cycle', count(*)::int, avg(extract(epoch FROM started_at - first_at))::float8
      FROM stays WHERE ended_at IS NULL AND stage::text IN ('CLOSED_WON', 'CLOSED_LOST')
        AND started_at >= ${period.start} AND started_at < ${period.endExclusive}
      GROUP BY stage`;
  const pick = (stage: string, kind: string) => {
    const r = rows.find((x) => x.stage === stage && x.kind === kind);
    return { count: r?.count ?? 0, avgDays: days(r?.avg_seconds ?? null) };
  };
  return {
    from: period.from,
    to: period.to,
    stages: OPEN_STAGES.map((stage) => ({ stage, completed: pick(stage, 'done'), current: pick(stage, 'current') })),
    cycle: { won: pick('CLOSED_WON', 'cycle'), lost: pick('CLOSED_LOST', 'cycle') },
  };
}

