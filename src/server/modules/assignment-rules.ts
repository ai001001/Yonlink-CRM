/**
 * 线索分配规则（对标 Zoho Assignment Rules）：按顺序逐条匹配，第一条条件全部满足的规则在其负责人中轮流分配。
 * - 条件最多 5 条（全部满足）：来源 / 市场活动 / 网页表单为“等于”；公司、职位、邮箱、描述支持等于、包含、开头是、结尾是
 *   （不区分大小写，去首尾空格）；没有条件的规则匹配全部（适合放在最后兜底）。
 * - 轮流分配：规则保存已分配次数，按负责人顺序循环；已停用的负责人跳过；负责人全部停用时继续尝试下一条规则。
 *   轮转指针在分配事务内原子递增，并发提交不会分给同一人两次；分配持共享锁、保存持排他锁，保存期间的提交等待保存完成后按新规则分配。
 * - 应用场景：网页表单设为“按分配规则”时的提交、导入时选择“按分配规则”（文件中指定负责人的行除外）、线索列表批量“按规则重新分配”。
 * - 查看：所有用户；保存：需 assignment.manage（管理员、经理），整体替换并写审计；保存后轮转指针从头开始。
 * Lead assignment rules (cf. Zoho Assignment Rules): tried in order; the first rule whose conditions all hold assigns
 * round-robin among its users. Up to 5 conditions (all must hold): source / campaign / web form use "equals"; company,
 * title, email and description support equals, contains, starts with and ends with (case-insensitive, trimmed); a rule
 * without conditions matches everything (a catch-all to put last). The rule keeps its assignment count and cycles
 * through its users in order, skipping inactive ones; when all are inactive the next rule is tried. The pointer is
 * incremented atomically inside the assigning transaction; assignments hold a shared lock and saves an exclusive one, so
 * a submission during a save waits and uses the new rules. Used by web forms set to "assignment rules", imports that
 * choose rules (rows naming an owner excepted) and the lead list's bulk "reassign by rules". Everyone can read;
 * saving needs assignment.manage (admins, managers), replaces the rules, is audited and restarts the pointers.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { AssignmentEntity } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { assertCanUpdate, requirePermission } from '../permissions';
import { requiredText } from '../validation';
import { assertKnownOptions } from './picklists';
import { picklistCode } from './picklists';
import { getLead } from './leads';
import { notifyAssigned } from './notifications';

/** 文本字段 / text fields */
export const TEXT_FIELDS = ['company', 'title', 'email', 'description'] as const;
/** 文本比较方式 / text operators */
export const TEXT_OPS = ['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH'] as const;
/** 每组织最多规则数 / max rules per organization */
export const MAX_RULES = 50;
/** 每条规则最多负责人数 / max users per rule */
export const MAX_RULE_USERS = 20;

/** 分配条件 / an assignment condition */
export const conditionSchema = z.union([
  z.strictObject({ field: z.literal('source'), op: z.literal('EQUALS'), value: picklistCode }),
  z.strictObject({ field: z.enum(['campaign', 'webForm']), op: z.literal('EQUALS'), value: z.uuid() }),
  z.strictObject({ field: z.enum(TEXT_FIELDS), op: z.enum(TEXT_OPS), value: requiredText(200) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

/** 一条规则 / one rule */
const ruleSchema = z.strictObject({
  name: requiredText(100),
  isActive: z.boolean().default(true),
  conditions: z.array(conditionSchema).max(5).default([]),
  userIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_RULE_USERS)
    .refine((v) => new Set(v).size === v.length, 'Duplicate users'),
});

/** 保存规则（整体替换）/ save the rules (replaces all) */
export const assignmentSaveSchema = z.strictObject({ rules: z.array(ruleSchema).max(MAX_RULES) });

/** 用于匹配的线索字段 / lead fields used for matching */
export interface LeadFacts {
  source?: string | null;
  campaignId?: string | null;
  webFormId?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  description?: string | null;
}

/** 规范化文本（去首尾空格、小写）/ normalize text (trim, lower case) */
const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * 单个条件是否成立。
 * Whether one condition holds.
 */
export function conditionHolds(c: Condition, lead: LeadFacts): boolean {
  if (c.field === 'source') return lead.source === c.value;
  if (c.field === 'campaign') return lead.campaignId === c.value;
  if (c.field === 'webForm') return lead.webFormId === c.value;
  const actual = norm(lead[c.field]);
  const expected = norm(c.value);
  if (!actual) return false;
  switch (c.op) {
    case 'EQUALS':
      return actual === expected;
    case 'CONTAINS':
      return actual.includes(expected);
    case 'STARTS_WITH':
      return actual.startsWith(expected);
    case 'ENDS_WITH':
      return actual.endsWith(expected);
  }
}

/**
 * 规则是否匹配（全部条件成立；无条件即匹配）。
 * Whether a rule matches (all conditions hold; no conditions always match).
 */
export function ruleMatches(conditions: readonly Condition[], lead: LeadFacts): boolean {
  return conditions.every((c) => conditionHolds(c, lead));
}

/** 规则锁的键（保存：排他；分配：共享）/ the rules lock key (exclusive for saves, shared for assignments) */
const lockKey = (organizationId: string) => `assignment:${organizationId}:LEAD`;

/** 读取存储的条件（数据库内容已在保存时校验，这里再防御一次）/ parse stored conditions defensively */
function storedConditions(raw: Prisma.JsonValue): Condition[] {
  const parsed = z.array(conditionSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** 分配结果 / an assignment result */
export interface Assignment {
  ownerId: string;
  ruleId: string;
  ruleName: string;
}

/**
 * 按规则为线索挑选负责人，并递增命中规则的轮转指针（在调用方事务内执行）。
 * Pick an owner for a lead by the rules and advance the matched rule's pointer (inside the caller's transaction).
 * @returns 分配结果；没有规则命中或命中规则无可用负责人时为 null / the assignment, or null when nothing applies
 */
export async function assignByRules(tx: Prisma.TransactionClient, organizationId: string, lead: LeadFacts): Promise<Assignment | null> {
  // 共享锁：与保存互斥（保存先删后建，期间读取会拿到已删除的规则），分配之间互不阻塞
  // shared lock: excludes saves (which delete and recreate rules) without blocking other assignments
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock_shared(hashtextextended(${lockKey(organizationId)}, 0))`;
  const rules = await tx.assignmentRule.findMany({
    where: { organizationId, entity: AssignmentEntity.LEAD, isActive: true },
    select: { id: true, name: true, conditions: true, users: { select: { userId: true, user: { select: { isActive: true } } }, orderBy: { position: 'asc' } } },
    orderBy: { position: 'asc' },
  });
  for (const rule of rules) {
    if (!ruleMatches(storedConditions(rule.conditions), lead)) continue;
    const active = rule.users.filter((u) => u.user.isActive).map((u) => u.userId);
    if (!active.length) continue;
    // 行锁内原子递增，并发分配按顺序取号 / atomic increment under the row lock; concurrent assignments take turns
    const [row] = await tx.$queryRaw<{ cursor: number }[]>`
      UPDATE "assignment_rules" SET "cursor" = "cursor" + 1 WHERE "id" = ${rule.id}::uuid AND "organization_id" = ${organizationId}::uuid RETURNING "cursor"`;
    if (!row) continue; // 防御：锁保证不会发生 / defensive; the lock prevents this
    return { ownerId: active[(row.cursor - 1) % active.length]!, ruleId: rule.id, ruleName: rule.name };
  }
  return null;
}

/**
 * 读取分配规则（按顺序，含负责人、条件中引用的市场活动与表单名称）。
 * Read the rules in order with their users and the names of campaigns and forms referenced by conditions.
 */
export async function getAssignmentRules(ctx: AuthContext, client: Prisma.TransactionClient = prisma) {
  const rules = await client.assignmentRule.findMany({
    where: { organizationId: ctx.organizationId, entity: AssignmentEntity.LEAD },
    select: {
      id: true,
      name: true,
      isActive: true,
      conditions: true,
      cursor: true,
      users: { select: { user: { select: { id: true, name: true, isActive: true } } }, orderBy: { position: 'asc' } },
    },
    orderBy: { position: 'asc' },
  });
  const list = rules.map((r) => ({ id: r.id, name: r.name, isActive: r.isActive, cursor: r.cursor, conditions: storedConditions(r.conditions), users: r.users.map((u) => u.user) }));
  const ids = (field: 'campaign' | 'webForm') => [...new Set(list.flatMap((r) => r.conditions.filter((c) => c.field === field).map((c) => c.value)))];
  const [campaigns, webForms] = await Promise.all([
    client.campaign.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids('campaign') } }, select: { id: true, name: true } }),
    client.webForm.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids('webForm') } }, select: { id: true, name: true } }),
  ]);
  return {
    rules: list,
    names: { campaign: Object.fromEntries(campaigns.map((c) => [c.id, c.name])), webForm: Object.fromEntries(webForms.map((f) => [f.id, f.name])) },
  };
}

/** 规则的审计文本（不含个人信息以外的内容；条件值原样记录）/ audit text of a rule */
function ruleText(rule: { name: string; isActive: boolean; conditions: Condition[] }, users: string[]): string {
  const conds = rule.conditions.map((c) => `${c.field} ${c.op} ${c.value}`).join(' & ') || '*';
  return `${rule.name}${rule.isActive ? '' : ' (off)'}: ${conds} → ${users.join('/')}`;
}

/**
 * 保存分配规则（整体替换，顺序即数组顺序），写审计；负责人须为本组织启用用户，引用的市场活动与表单须属于本组织。
 * Save the rules (replace all, in array order), audited. Users must be active members; referenced campaigns and forms
 * must belong to the organization.
 */
export async function saveAssignmentRules(ctx: AuthContext, input: z.infer<typeof assignmentSaveSchema>) {
  requirePermission(ctx, 'assignment.manage');
  const org = ctx.organizationId;
  await assertKnownOptions(org, input.rules.flatMap((r, i) => r.conditions.flatMap((c, j) => (c.field === 'source' ? [{ field: c.field, value: c.value, key: `rules.${i}.conditions.${j}.value` }] : []))));
  const userIds = [...new Set(input.rules.flatMap((r) => r.userIds))];
  const users = await prisma.user.findMany({ where: { organizationId: org, id: { in: userIds }, isActive: true }, select: { id: true, name: true } });
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const errors: Record<string, string[]> = {};
  const refIds = (field: 'campaign' | 'webForm') => [...new Set(input.rules.flatMap((r) => r.conditions.filter((c) => c.field === field).map((c) => c.value)))];
  const [campaigns, forms] = await Promise.all([
    prisma.campaign.findMany({ where: { organizationId: org, id: { in: refIds('campaign') } }, select: { id: true } }),
    prisma.webForm.findMany({ where: { organizationId: org, id: { in: refIds('webForm') } }, select: { id: true } }),
  ]);
  const known = { campaign: new Set(campaigns.map((c) => c.id)), webForm: new Set(forms.map((f) => f.id)) };
  input.rules.forEach((r, i) => {
    if (r.userIds.some((id) => !userName.has(id))) errors[`rules.${i}.userIds`] = ['user_not_found'];
    r.conditions.forEach((c, j) => {
      if ((c.field === 'campaign' || c.field === 'webForm') && !known[c.field].has(c.value)) errors[`rules.${i}.conditions.${j}`] = ['not_found'];
    });
  });
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid assignment rules', errors);

  await prisma.$transaction(async (tx) => {
    // 排他锁：保存之间串行，并等待进行中的分配完成 / exclusive lock: saves run one at a time and wait for running assignments
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${lockKey(org)}, 0))`;
    const before = await getAssignmentRules(ctx, tx);
    await tx.assignmentRule.deleteMany({ where: { organizationId: org, entity: AssignmentEntity.LEAD } });
    for (const [position, r] of input.rules.entries()) {
      await tx.assignmentRule.create({
        data: {
          organizationId: org,
          entity: AssignmentEntity.LEAD,
          name: r.name,
          isActive: r.isActive,
          conditions: r.conditions,
          position,
          users: { create: r.userIds.map((userId, p) => ({ userId, position: p })) },
        },
      });
    }
    const rulesBefore = before.rules.map((r) => ruleText(r, r.users.map((u) => u.name)));
    const rulesAfter = input.rules.map((r) => ruleText(r, r.userIds.map((id) => userName.get(id)!)));
    const changes: Record<string, unknown> = { entity: AssignmentEntity.LEAD, count: input.rules.length };
    if (rulesBefore.join('|') !== rulesAfter.join('|')) changes.rules = [rulesBefore, rulesAfter];
    await audit(tx, { ...by(ctx), action: 'assignment.update', entityType: 'assignment', entityId: null, changes });
  });
  return getAssignmentRules(ctx);
}

/**
 * 按规则重新分配一条线索（批量操作逐条调用）：需能编辑该线索；已转化的线索不再分配；没有规则命中返回 409。
 * 负责人变化时写审计（注明规则）并通知新负责人。
 * Reassign one lead by the rules (called per record by the bulk action). Needs edit rights; converted leads are not
 * reassigned; no matching rule yields 409. An owner change is audited with the rule name and notifies the new owner.
 */
export async function reassignLead(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'owner.assign');
  const lead = await getLead(ctx, id);
  assertCanUpdate(ctx, lead);
  if (lead.convertedAt) throw new ApiError(409, 'CONFLICT', 'Lead already converted', { status: ['converted'] });
  return prisma.$transaction(async (tx) => {
    const assigned = await assignByRules(tx, ctx.organizationId, lead);
    if (!assigned) throw new ApiError(409, 'CONFLICT', 'No assignment rule matched', { ownerId: ['no_rule_matched'] });
    if (assigned.ownerId !== lead.ownerId) {
      await tx.lead.update({ where: { id: lead.id }, data: { ownerId: assigned.ownerId } });
      await audit(tx, {
        ...by(ctx),
        action: 'lead.update',
        entityType: 'lead',
        entityId: lead.id,
        changes: { fields: { ownerId: [lead.ownerId, assigned.ownerId] }, assignmentRule: assigned.ruleName },
      });
      await notifyAssigned(tx, ctx, { entity: 'lead', id: lead.id }, lead.name, assigned.ownerId, lead.ownerId);
    }
    return { id: lead.id, ownerId: assigned.ownerId, rule: assigned.ruleName };
  });
}
