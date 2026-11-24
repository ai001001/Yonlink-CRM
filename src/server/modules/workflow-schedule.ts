/**
 * 定时工作流（对标 Zoho 基于日期的工作流与定时动作）：由定时任务检查“相对日期”与“无跟进”两类规则。
 * - 相对日期：线索创建日、商机创建日或预计成交日之前/之后 N 天（UTC 日期）。触发日在规则创建日之后、且不早于 7 天前
 *   （停机补做的上限）时执行；同一记录同一日期值只执行一次（日期改了会按新日期再触发）。
 * - 无跟进：最近一次跟进（或记录创建时间）距今达到 N 天；已转化线索与已结束商机不检查；每段沉默期只执行一次
 *   （有新跟进后重新计时）。
 * - 条件在触发时按当前值判断，不满足则本次不执行（同一触发键不再检查）。动作与即时工作流相同，以系统身份执行
 *   （操作人为空）。每条规则每次最多处理 500 条记录，余下的下次继续。
 * Scheduled workflows (cf. Zoho date-based workflows and scheduled actions): a timer job checks "relative date" and
 * "inactivity" rules. Relative date: N days before/after a lead's or deal's creation date or a deal's expected close
 * date (UTC days); runs when the trigger day is on or after the rule's creation day and within the last 7 days (the
 * catch-up limit); once per record and date value (a changed date triggers again). Inactivity: the latest activity (or
 * the record's creation) is N days old; converted leads and closed deals are skipped; once per quiet period (a new
 * activity restarts the clock). Conditions are evaluated at trigger time on current values; when they fail the key is
 * not checked again. Actions match instant workflows and run as the system. At most 500 records per rule per run.
 */
import { Prisma } from '@/generated/prisma/client';
import { WorkflowEntity, WorkflowTrigger } from '@/generated/prisma/enums';
import { prisma } from '../db';
import { executeRule } from './workflows';

/** 每条规则每次最多处理的记录数 / max records per rule per run */
const BATCH = 500;
/** 相对日期的补做上限（天）/ catch-up limit for relative dates (days) */
const CATCH_UP_DAYS = 7;

/** UTC 日期字符串 / UTC date string */
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 找出某条规则此刻应触发的记录（ID 与触发键），排除已执行过的。
 * Records a rule should fire for now (id and trigger key), excluding ones already run.
 */
async function candidates(rule: { id: string; organizationId: string; entity: WorkflowEntity; trigger: WorkflowTrigger; triggerField: string | null; triggerDays: number | null; createdAt: Date }, now: Date) {
  const org = rule.organizationId;
  const days = rule.triggerDays ?? 0;
  if (rule.trigger === WorkflowTrigger.DATE_RELATIVE) {
    const today = ymd(now);
    const created = ymd(rule.createdAt);
    const floor = ymd(new Date(now.getTime() - CATCH_UP_DAYS * 86_400_000));
    const lower = created > floor ? created : floor;
    // 表与日期列固定，不拼接用户输入 / fixed tables and columns; no user input is interpolated
    const table = { LEAD: Prisma.sql`leads`, DEAL: Prisma.sql`deals`, ACCOUNT: Prisma.sql`accounts`, TICKET: Prisma.sql`tickets` }[rule.entity];
    const column =
      rule.triggerField === 'expectedCloseDate'
        ? Prisma.sql`t.expected_close_date`
        : rule.triggerField === 'dueAt'
          ? Prisma.sql`(t.due_at AT TIME ZONE 'UTC')::date`
          : Prisma.sql`(t.created_at AT TIME ZONE 'UTC')::date`;
    return prisma.$queryRaw<{ id: string; key: string }[]>`
      SELECT t.id, ${column}::text AS key FROM ${table} t
      WHERE t.organization_id = ${org}::uuid AND ${column} IS NOT NULL
        AND (${column} + ${days}::int) BETWEEN ${lower}::date AND ${today}::date
        AND NOT EXISTS (SELECT 1 FROM workflow_schedule_runs r WHERE r.rule_id = ${rule.id}::uuid AND r.record_id = t.id AND r.key = ${column}::text)
      ORDER BY t.id LIMIT ${BATCH}`;
  }
  // 无跟进：最近一次跟进时间与创建时间取较晚者 / inactivity: the later of the latest activity and the creation time
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  if (rule.entity === WorkflowEntity.LEAD) {
    return prisma.$queryRaw<{ id: string; key: string }[]>`
      SELECT id, key FROM (
        SELECT l.id, to_char(greatest(l.created_at, coalesce((SELECT max(a.created_at) FROM activities a WHERE a.organization_id = l.organization_id AND a.lead_id = l.id), l.created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS key,
               greatest(l.created_at, coalesce((SELECT max(a.created_at) FROM activities a WHERE a.organization_id = l.organization_id AND a.lead_id = l.id), l.created_at)) AS touched
        FROM leads l WHERE l.organization_id = ${org}::uuid AND l.status <> 'CONVERTED'
      ) x
      WHERE touched <= ${cutoff} AND NOT EXISTS (SELECT 1 FROM workflow_schedule_runs r WHERE r.rule_id = ${rule.id}::uuid AND r.record_id = x.id AND r.key = x.key)
      ORDER BY id LIMIT ${BATCH}`;
  }
  if (rule.entity === WorkflowEntity.ACCOUNT) {
    return prisma.$queryRaw<{ id: string; key: string }[]>`
      SELECT id, key FROM (
        SELECT c.id, to_char(greatest(c.created_at, coalesce((SELECT max(a.created_at) FROM activities a WHERE a.organization_id = c.organization_id AND a.account_id = c.id), c.created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS key,
               greatest(c.created_at, coalesce((SELECT max(a.created_at) FROM activities a WHERE a.organization_id = c.organization_id AND a.account_id = c.id), c.created_at)) AS touched
        FROM accounts c WHERE c.organization_id = ${org}::uuid
      ) x
      WHERE touched <= ${cutoff} AND NOT EXISTS (SELECT 1 FROM workflow_schedule_runs r WHERE r.rule_id = ${rule.id}::uuid AND r.record_id = x.id AND r.key = x.key)
      ORDER BY id LIMIT ${BATCH}`;
  }
  if (rule.entity === WorkflowEntity.TICKET) return []; // 工单没有跟进记录（保存时已拒绝）/ tickets have no activities (refused on save)
  return prisma.$queryRaw<{ id: string; key: string }[]>`
    SELECT id, key FROM (
      SELECT d.id, to_char(greatest(d.created_at, coalesce((SELECT max(a.created_at) FROM activities a WHERE a.organization_id = d.organization_id AND a.deal_id = d.id), d.created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS key,
             greatest(d.created_at, coalesce((SELECT max(a.created_at) FROM activities a WHERE a.organization_id = d.organization_id AND a.deal_id = d.id), d.created_at)) AS touched
      FROM deals d WHERE d.organization_id = ${org}::uuid AND d.stage NOT IN ('CLOSED_WON', 'CLOSED_LOST')
    ) x
    WHERE touched <= ${cutoff} AND NOT EXISTS (SELECT 1 FROM workflow_schedule_runs r WHERE r.rule_id = ${rule.id}::uuid AND r.record_id = x.id AND r.key = x.key)
    ORDER BY id LIMIT ${BATCH}`;
}

/**
 * 读取触发的记录（工单以“编号 主题”作为名称）。
 * Load the triggered record (tickets use "number subject" as the name).
 */
async function loadRecord(tx: Prisma.TransactionClient, entity: WorkflowEntity, organizationId: string, id: string) {
  const where = { id, organizationId };
  switch (entity) {
    case WorkflowEntity.LEAD:
      return tx.lead.findFirst({ where });
    case WorkflowEntity.DEAL:
      return tx.deal.findFirst({ where });
    case WorkflowEntity.ACCOUNT:
      return tx.account.findFirst({ where });
    case WorkflowEntity.TICKET: {
      const t = await tx.ticket.findFirst({ where });
      return t && { ...t, name: `${t.ticketNumber} ${t.subject}` };
    }
  }
}

/**
 * 执行到期的定时工作流（定时任务入口；可指定组织）。每条记录在独立事务内先登记执行键（并发运行时只有一个成功），再执行规则。
 * Run due scheduled workflows (timer entry; optionally one organization). Each record registers its run key in its own
 * transaction first (concurrent runs: one wins), then the rule runs.
 */
export async function sweepScheduledWorkflows(opts: { organizationId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const rules = await prisma.workflowRule.findMany({
    where: { organizationId: opts.organizationId, isActive: true, trigger: { in: [WorkflowTrigger.DATE_RELATIVE, WorkflowTrigger.INACTIVITY] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const result = { rules: rules.length, checked: 0, ran: 0, failures: [] as { ruleId: string; error: string }[] };
  for (const rule of rules) {
    try {
      for (const c of await candidates(rule, now)) {
        result.checked += 1;
        const ran = await prisma.$transaction(async (tx) => {
          const inserted = await tx.$executeRaw`
            INSERT INTO workflow_schedule_runs (id, organization_id, rule_id, record_id, key, ran_at)
            VALUES (gen_random_uuid(), ${rule.organizationId}::uuid, ${rule.id}::uuid, ${c.id}::uuid, ${c.key}, ${now})
            ON CONFLICT (rule_id, record_id, key) DO NOTHING`;
          if (inserted !== 1) return false;
          const record = await loadRecord(tx, rule.entity, rule.organizationId, c.id);
          if (!record) return false;
          return executeRule(tx, rule, { entity: rule.entity, before: record, after: record, actorId: null }, { ...record });
        });
        if (ran) result.ran += 1;
      }
    } catch (err) {
      result.failures.push({ ruleId: rule.id, error: (err as Error).message.slice(0, 200) });
    }
  }
  return result;
}
