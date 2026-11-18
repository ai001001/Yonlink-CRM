/**
 * 线索评分（对标 Zoho Scoring Rules）：按组织的评分规则给线索打分，并分为热门、温和、冷淡三级。
 * - 规则类型：字段等于某值（来源、状态）；字段已填写（公司、职位、邮箱、电话、手机、留言、市场活动、网页表单）；
 *   已完成跟进数（每条加分，最多计入若干条）。分值 -100–100，可为负分。
 * - 分数由数据库函数 lead_score_items 与触发器在每次写入线索、跟进变化时计算，任何写入途径都不会遗漏，客户端不能写入。
 * - 所有用户可查看规则与线索的得分明细；修改规则与分级阈值需 scoring.manage（管理员、经理）。
 *   保存时整体替换规则并在同一事务内重算本组织全部线索，写审计。
 * Lead scoring (cf. Zoho Scoring Rules): leads are scored by the organization's rules and graded hot, warm or cold.
 * Rule kinds: field equals a value (source, status); field filled (company, title, email, phone, mobile, message,
 * campaign, web form); completed activities (points each, capped). Points range -100..100 and may be negative. Scores are
 * computed by the database function lead_score_items and triggers on every lead write and activity change, so no write
 * path can skip them and clients cannot write them. Everyone can read the rules and a lead's breakdown; changing rules
 * and thresholds needs scoring.manage (admins, managers). Saving replaces the rule set and rescores all of the
 * organization's leads in the same transaction, audited.
 */
import { z } from 'zod';
import { LeadScoringRuleKind, LeadStatus } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { notFound } from '../errors';
import { requirePermission, visible } from '../permissions';
import { LEAD_SOURCES, scoreThresholds } from './leads';

/** “已填写”规则可用的字段 / fields for FIELD_FILLED rules */
export const FILLED_FIELDS = ['company', 'title', 'email', 'phone', 'mobile', 'description', 'campaign', 'web_form'] as const;

const points = z
  .number()
  .int()
  .min(-100)
  .max(100)
  .refine((v) => v !== 0, 'Points cannot be 0');

const base = { points, isActive: z.boolean().default(true) };

/**
 * 规则（按类型区分字段）。“字段等于”有来源、状态两种取值集合，同一类型值不能用 discriminatedUnion，改用 union。
 * A rule, fields depending on the kind. FIELD_EQUALS has two value sets (source, status), and a discriminated union
 * cannot repeat a discriminator value, so a plain union is used.
 */
const ruleSchema = z.union([
  z.strictObject({ kind: z.literal(LeadScoringRuleKind.FIELD_EQUALS), field: z.literal('source'), value: z.enum(LEAD_SOURCES), ...base }),
  z.strictObject({ kind: z.literal(LeadScoringRuleKind.FIELD_EQUALS), field: z.literal('status'), value: z.enum(LeadStatus), ...base }),
  z.strictObject({ kind: z.literal(LeadScoringRuleKind.FIELD_FILLED), field: z.enum(FILLED_FIELDS), ...base }),
  z.strictObject({ kind: z.literal(LeadScoringRuleKind.ACTIVITY_COUNT), maxCount: z.number().int().min(1).max(50), ...base }),
]);
type RuleInput = z.infer<typeof ruleSchema>;

/** 保存评分设置（整体替换规则）/ Save the scoring setup (replaces all rules) */
export const scoringSaveSchema = z
  .strictObject({
    rules: z.array(ruleSchema).max(50),
    hotScore: z.number().int().min(1).max(1000),
    warmScore: z.number().int().min(0).max(999),
  })
  .refine((v) => v.hotScore > v.warmScore, { path: ['hotScore'], message: 'above_warm' });

/** 规则的审计文本，如 source=WEBSITE:+20、filled:email:+10、activities×3:+5 / audit text of a rule */
function ruleText(r: { kind: string; field?: string | null; value?: string | null; points: number; maxCount?: number | null; isActive?: boolean }): string {
  const pts = `${r.points > 0 ? '+' : ''}${r.points}`;
  const off = r.isActive === false ? ' (off)' : '';
  if (r.kind === LeadScoringRuleKind.FIELD_EQUALS) return `${r.field}=${r.value}:${pts}${off}`;
  if (r.kind === LeadScoringRuleKind.FIELD_FILLED) return `filled:${r.field}:${pts}${off}`;
  return `activities×${r.maxCount}:${pts}${off}`;
}

/**
 * 评分设置：规则（按顺序）与分级阈值；未设置阈值时为默认值。
 * The scoring setup: rules in order and the grade thresholds (defaults when unset).
 */
export async function getScoring(ctx: AuthContext) {
  const [rules, thresholds] = await Promise.all([
    prisma.leadScoringRule.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
    scoreThresholds(ctx.organizationId),
  ]);
  return { rules, ...thresholds };
}

/**
 * 保存评分设置：整体替换规则与阈值，并在同一事务内重算本组织全部线索的分数。
 * Save the setup: replace the rules and thresholds, then rescore all of the organization's leads in the same transaction.
 * @returns 新的设置与重算的线索数 / the new setup and how many leads were rescored
 */
export async function saveScoring(ctx: AuthContext, input: z.infer<typeof scoringSaveSchema>) {
  requirePermission(ctx, 'scoring.manage');
  const before = await getScoring(ctx);
  const org = ctx.organizationId;
  const rescored = await prisma.$transaction(async (tx) => {
    // 同一组织的保存串行执行，避免并发保存交错 / serialize saves per organization
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`lead-scoring:${org}`}, 0))`;
    await tx.leadScoringRule.deleteMany({ where: { organizationId: org } });
    if (input.rules.length) {
      await tx.leadScoringRule.createMany({
        data: input.rules.map((r: RuleInput, position) => ({
          organizationId: org,
          kind: r.kind,
          field: 'field' in r ? r.field : null,
          value: 'value' in r ? r.value : null,
          maxCount: 'maxCount' in r ? r.maxCount : null,
          points: r.points,
          isActive: r.isActive,
          position,
        })),
      });
    }
    await tx.leadScoringSettings.upsert({
      where: { organizationId: org },
      create: { organizationId: org, hotScore: input.hotScore, warmScore: input.warmScore },
      update: { hotScore: input.hotScore, warmScore: input.warmScore },
    });
    // 触发器在更新时按新规则重新计算分数 / the trigger recomputes each score from the new rules on update
    const count = await tx.$executeRaw`UPDATE "leads" SET "score" = "score" WHERE "organization_id" = ${org}::uuid`;
    const changes: Record<string, unknown> = { rescored: count };
    const rulesBefore = before.rules.map(ruleText);
    const rulesAfter = input.rules.map(ruleText);
    if (rulesBefore.join('|') !== rulesAfter.join('|')) changes.rules = [rulesBefore, rulesAfter];
    if (before.hotScore !== input.hotScore) changes.hotScore = [before.hotScore, input.hotScore];
    if (before.warmScore !== input.warmScore) changes.warmScore = [before.warmScore, input.warmScore];
    await audit(tx, { ...by(ctx), action: 'scoring.update', entityType: 'scoring', entityId: null, changes });
    return count;
  });
  return { ...(await getScoring(ctx)), rescored };
}

/** 分级 / grade */
export type ScoreGrade = 'hot' | 'warm' | 'cold';

/**
 * 按阈值分级。
 * Grade a score by the thresholds.
 */
export function gradeOf(score: number, t: { hotScore: number; warmScore: number }): ScoreGrade {
  return score >= t.hotScore ? 'hot' : score >= t.warmScore ? 'warm' : 'cold';
}

/**
 * 线索的得分明细：命中的规则与得分（与数据库计算同一函数）、总分与分级；线索不可见时 404。
 * A lead's score breakdown: the matched rules and points (the same database function), the total and the grade; 404 when
 * the lead is not visible.
 */
export async function explainScore(ctx: AuthContext, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, ...visible(ctx) }, select: { id: true, score: true } });
  if (!lead) throw notFound();
  const rows = await prisma.$queryRaw<{ rule_id: string; points: number }[]>`
    SELECT i.rule_id, i.points FROM "leads" l, "lead_score_items"(l) i WHERE l.id = ${lead.id}::uuid AND l.organization_id = ${ctx.organizationId}::uuid`;
  const rules = await prisma.leadScoringRule.findMany({ where: { organizationId: ctx.organizationId, id: { in: rows.map((r) => r.rule_id) } } });
  const byId = new Map(rules.map((r) => [r.id, r]));
  const items = rows.flatMap((r) => {
    const rule = byId.get(r.rule_id);
    return rule ? [{ ruleId: rule.id, kind: rule.kind, field: rule.field, value: rule.value, maxCount: rule.maxCount, points: r.points }] : [];
  });
  const thresholds = await scoreThresholds(ctx.organizationId);
  return { score: lead.score, grade: gradeOf(lead.score, thresholds), items, ...thresholds };
}
