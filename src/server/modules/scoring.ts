/**
 * 评分（对标 Zoho Scoring Rules）：按组织为线索、客户、联系人分别配置评分规则与分级阈值（热门、温和、冷淡）。
 * - 线索：来源、状态等于；公司、职位、邮箱、电话、手机、描述、来源市场活动、来源网页表单已填写；已完成跟进数。
 * - 客户：行业等于；电话、网站、地址、描述、价格表已填写；已完成跟进数；联系人数、赢单商机数、进行中商机数。
 * - 联系人：是主要联系人；职位、电话、邮箱已填写；在商机中担任的角色数、决策人角色数。
 * - 计数类规则每条加分并有上限；分值 -100–100，可为负分；规则可停用。
 * - 分数由数据库函数（lead_score_items、account_score_items、contact_score_items）与触发器在记录及相关记录变化时计算，
 *   任何写入途径都不会遗漏，客户端不能写入。
 * - 所有用户可查看规则与可见记录的得分明细；修改需 scoring.manage（管理员、经理）。保存时整体替换该对象的规则，
 *   并在同一事务内重算本组织该对象的全部记录，写审计。
 * Scoring (cf. Zoho Scoring Rules): per-organization rules and grade thresholds (hot, warm, cold) for leads, accounts and
 * contacts. Leads: source/status equals; company, title, email, phone, mobile, description, campaign, web form filled;
 * completed activities. Accounts: industry equals; phone, website, address, description, price book filled; completed
 * activities; contacts, won deals, open deals. Contacts: is primary; title, phone, email filled; deal roles,
 * decision-maker roles. Count rules score per item up to a cap; points range -100..100 and may be negative; rules can be
 * switched off. Scores are computed by database functions and triggers whenever a record or a related record changes, so
 * no write path can skip them and clients cannot write them. Everyone can read the rules and the breakdown of records they
 * can see; changes need scoring.manage (admins, managers). Saving replaces the entity's rules and rescores all of its
 * records in the organization in the same transaction, audited.
 */
import { z } from 'zod';
import { LeadStatus, ScoringEntity, ScoringRuleKind } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { notFound } from '../errors';
import { requirePermission, visible } from '../permissions';
import { INDUSTRIES } from './accounts';
import { LEAD_SOURCES } from './leads';
import { gradeOf, scoreThresholds } from './scoring-grades';

/** 路径中的对象名 → 评分对象 / entity name in the URL → scoring entity */
export const ENTITY_PARAM = { lead: ScoringEntity.LEAD, account: ScoringEntity.ACCOUNT, contact: ScoringEntity.CONTACT } as const;
export const entityParamSchema = z.enum(['lead', 'account', 'contact']);

const points = z
  .number()
  .int()
  .min(-100)
  .max(100)
  .refine((v) => v !== 0, 'Points cannot be 0');
const maxCount = z.number().int().min(1).max(50);
const base = { points, isActive: z.boolean().default(true) };
const { FIELD_EQUALS, FIELD_FILLED, ACTIVITY_COUNT, RELATED_COUNT } = ScoringRuleKind;

/**
 * 各对象的规则（按类型区分字段）。同一类型有多种取值集合时不能用 discriminatedUnion（类型值重复会在运行时报错），改用 union。
 * Rules per entity, fields depending on the kind. A kind with several value sets cannot use a discriminated union (a
 * repeated discriminator fails at runtime), so plain unions are used.
 */
const RULES = {
  [ScoringEntity.LEAD]: z.union([
    z.strictObject({ kind: z.literal(FIELD_EQUALS), field: z.literal('source'), value: z.enum(LEAD_SOURCES), ...base }),
    z.strictObject({ kind: z.literal(FIELD_EQUALS), field: z.literal('status'), value: z.enum(LeadStatus), ...base }),
    z.strictObject({ kind: z.literal(FIELD_FILLED), field: z.enum(['company', 'title', 'email', 'phone', 'mobile', 'description', 'campaign', 'web_form']), ...base }),
    z.strictObject({ kind: z.literal(ACTIVITY_COUNT), maxCount, ...base }),
  ]),
  [ScoringEntity.ACCOUNT]: z.union([
    z.strictObject({ kind: z.literal(FIELD_EQUALS), field: z.literal('industry'), value: z.enum(INDUSTRIES), ...base }),
    z.strictObject({ kind: z.literal(FIELD_FILLED), field: z.enum(['phone', 'website', 'address', 'description', 'price_book']), ...base }),
    z.strictObject({ kind: z.literal(ACTIVITY_COUNT), maxCount, ...base }),
    z.strictObject({ kind: z.literal(RELATED_COUNT), field: z.enum(['contacts', 'won_deals', 'open_deals']), maxCount, ...base }),
  ]),
  [ScoringEntity.CONTACT]: z.union([
    z.strictObject({ kind: z.literal(FIELD_EQUALS), field: z.literal('is_primary'), value: z.literal('true'), ...base }),
    z.strictObject({ kind: z.literal(FIELD_FILLED), field: z.enum(['title', 'phone', 'email']), ...base }),
    z.strictObject({ kind: z.literal(RELATED_COUNT), field: z.enum(['deal_roles', 'decision_roles']), maxCount, ...base }),
  ]),
};

/** 规则输入 / rule input */
type RuleInput = { kind: ScoringRuleKind; field?: string; value?: string; maxCount?: number; points: number; isActive: boolean };

/**
 * 保存评分设置的输入校验（按对象）。
 * Validation of a scoring save for an entity.
 */
export function scoringSaveSchema(entity: ScoringEntity) {
  return z
    .strictObject({
      rules: z.array(RULES[entity]).max(50),
      hotScore: z.number().int().min(1).max(1000),
      warmScore: z.number().int().min(0).max(999),
    })
    .refine((v) => v.hotScore > v.warmScore, { path: ['hotScore'], message: 'above_warm' });
}

/** 规则的审计文本，如 source=WEBSITE:+20、filled:email:+10、activities×3:+5、contacts×5:+4 / audit text of a rule */
function ruleText(r: { kind: string; field?: string | null; value?: string | null; points: number; maxCount?: number | null; isActive?: boolean }): string {
  const pts = `${r.points > 0 ? '+' : ''}${r.points}`;
  const off = r.isActive === false ? ' (off)' : '';
  if (r.kind === FIELD_EQUALS) return `${r.field}=${r.value}:${pts}${off}`;
  if (r.kind === FIELD_FILLED) return `filled:${r.field}:${pts}${off}`;
  if (r.kind === RELATED_COUNT) return `${r.field}×${r.maxCount}:${pts}${off}`;
  return `activities×${r.maxCount}:${pts}${off}`;
}

/**
 * 某对象的评分设置：规则（按顺序）与分级阈值；未设置阈值时为默认值。
 * An entity's scoring setup: rules in order and the thresholds (defaults when unset).
 */
export async function getScoring(ctx: AuthContext, entity: ScoringEntity) {
  const [rules, thresholds] = await Promise.all([
    prisma.scoringRule.findMany({ where: { organizationId: ctx.organizationId, entity }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
    scoreThresholds(ctx.organizationId, entity),
  ]);
  return { entity, rules, ...thresholds };
}

/**
 * 保存某对象的评分设置：整体替换规则与阈值，并在同一事务内重算本组织该对象的全部记录。
 * Save an entity's setup: replace its rules and thresholds, then rescore all of its records in the same transaction.
 * @returns 新的设置与重算的记录数 / the new setup and how many records were rescored
 */
export async function saveScoring(ctx: AuthContext, entity: ScoringEntity, input: { rules: RuleInput[]; hotScore: number; warmScore: number }) {
  requirePermission(ctx, 'scoring.manage');
  const before = await getScoring(ctx, entity);
  const org = ctx.organizationId;
  const rescored = await prisma.$transaction(async (tx) => {
    // 同一组织同一对象的保存串行执行，避免并发保存交错 / serialize saves per organization and entity
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`scoring:${org}:${entity}`}, 0))`;
    await tx.scoringRule.deleteMany({ where: { organizationId: org, entity } });
    if (input.rules.length) {
      await tx.scoringRule.createMany({
        data: input.rules.map((r, position) => ({
          organizationId: org,
          entity,
          kind: r.kind,
          field: r.field ?? null,
          value: r.value ?? null,
          maxCount: r.maxCount ?? null,
          points: r.points,
          isActive: r.isActive,
          position,
        })),
      });
    }
    await tx.scoringSettings.upsert({
      where: { organizationId_entity: { organizationId: org, entity } },
      create: { organizationId: org, entity, hotScore: input.hotScore, warmScore: input.warmScore },
      update: { hotScore: input.hotScore, warmScore: input.warmScore },
    });
    // 触发器在更新时按新规则重新计算分数（表名固定，不拼接用户输入）/ the trigger rescores on update (fixed table names)
    const count =
      entity === ScoringEntity.LEAD
        ? await tx.$executeRaw`UPDATE "leads" SET "score" = "score" WHERE "organization_id" = ${org}::uuid`
        : entity === ScoringEntity.ACCOUNT
          ? await tx.$executeRaw`UPDATE "accounts" SET "score" = "score" WHERE "organization_id" = ${org}::uuid`
          : await tx.$executeRaw`UPDATE "contacts" SET "score" = "score" WHERE "organization_id" = ${org}::uuid`;
    const changes: Record<string, unknown> = { entity, rescored: count };
    const rulesBefore = before.rules.map(ruleText);
    const rulesAfter = input.rules.map(ruleText);
    if (rulesBefore.join('|') !== rulesAfter.join('|')) changes.rules = [rulesBefore, rulesAfter];
    if (before.hotScore !== input.hotScore) changes.hotScore = [before.hotScore, input.hotScore];
    if (before.warmScore !== input.warmScore) changes.warmScore = [before.warmScore, input.warmScore];
    await audit(tx, { ...by(ctx), action: 'scoring.update', entityType: 'scoring', entityId: null, changes });
    return count;
  });
  return { ...(await getScoring(ctx, entity)), rescored };
}

/**
 * 记录的得分明细：命中的规则与得分（与数据库计算同一函数）、总分与分级；记录不可见时 404。
 * 联系人的可见范围跟随所属客户。
 * A record's breakdown: matched rules and points (the same database function), the total and the grade; 404 when not
 * visible. Contacts follow their account's visibility.
 */
export async function explainScore(ctx: AuthContext, entity: ScoringEntity, id: string) {
  const org = ctx.organizationId;
  let score: number;
  let rows: { rule_id: string; points: number }[];
  if (entity === ScoringEntity.LEAD) {
    const r = await prisma.lead.findFirst({ where: { id, ...visible(ctx) }, select: { score: true } });
    if (!r) throw notFound();
    score = r.score;
    rows = await prisma.$queryRaw`SELECT i.rule_id, i.points FROM "leads" l, "lead_score_items"(l) i WHERE l.id = ${id}::uuid AND l.organization_id = ${org}::uuid`;
  } else if (entity === ScoringEntity.ACCOUNT) {
    const r = await prisma.account.findFirst({ where: { id, ...visible(ctx) }, select: { score: true } });
    if (!r) throw notFound();
    score = r.score;
    rows = await prisma.$queryRaw`SELECT i.rule_id, i.points FROM "accounts" a, "account_score_items"(a) i WHERE a.id = ${id}::uuid AND a.organization_id = ${org}::uuid`;
  } else {
    const r = await prisma.contact.findFirst({ where: { id, organizationId: org, account: visible(ctx) }, select: { score: true } });
    if (!r) throw notFound();
    score = r.score;
    rows = await prisma.$queryRaw`SELECT i.rule_id, i.points FROM "contacts" c, "contact_score_items"(c) i WHERE c.id = ${id}::uuid AND c.organization_id = ${org}::uuid`;
  }
  const rules = await prisma.scoringRule.findMany({ where: { organizationId: org, id: { in: rows.map((r) => r.rule_id) } } });
  const byId = new Map(rules.map((r) => [r.id, r]));
  const items = rows.flatMap((r) => {
    const rule = byId.get(r.rule_id);
    return rule ? [{ ruleId: rule.id, kind: rule.kind, field: rule.field, value: rule.value, maxCount: rule.maxCount, points: r.points }] : [];
  });
  const thresholds = await scoreThresholds(org, entity);
  return { score, grade: gradeOf(score, thresholds), items, ...thresholds };
}
