/**
 * 报价单审批（对标 Zoho Approval Processes）。
 * - 审批规则（每组织一份）：启用后，任一明细折扣超过上限，或总计按当天汇率折合人民币达到金额（没有汇率时视为需要审批），
 *   报价单发送前须经审批。维护需 approval.manage（管理员、经理）并写审计。
 * - 流程：草稿 → 提交审批（待审批，锁定不能修改、删除、发送）→ 他人批准（可发送）或驳回（需填写意见，回到可编辑）；
 *   提交人或审批人可撤回待审批。批准或驳回后再修改草稿（含同步明细、改税率）会清空审批结果，需要重新审批。
 * - 审批人：有 quote.approve 权限（管理员、经理）的其他用户；不能审批自己提交的报价单。
 * - 多级审批：可设置最多 5 个级别（按顺序），每级指定审批角色（经理级：经理或管理员可批；管理员级：仅管理员），
 *   并可设只在折扣超过或金额达到时适用（都不设则总是适用）。提交时按报价单确定适用的级别并保存快照，之后改级别不影响
 *   已提交的审批；逐级批准，同一人不能批准同一次提交的两个级别；最后一级批准后完成，任何一级驳回即结束。
 *   没有设置级别时为一级审批（任一审批人）。
 * - 通知：提交时通知其他审批人；审批后通知提交人。全过程写审批历史（只增不改）与审计。
 * Quote approvals (cf. Zoho Approval Processes). Policy per organization: when enabled, a quote with any line discount
 * above the cap, or with a total converted to CNY at today's rate at or above the amount (no rate counts as needing
 * approval), must be approved before sending; maintenance needs approval.manage and is audited. Flow: draft → submit
 * (pending; locked against edit, delete and send) → approved by someone else (may be sent) or rejected (comment
 * required; editable again); the submitter or an approver may recall a pending request. Editing a decided draft (sync,
 * tax rate included) clears the decision. Approvers are other users with quote.approve; nobody approves their own
 * submission. Multi-level: up to 5 ordered levels, each naming an approver role (manager level: managers or admins;
 * admin level: admins only) and optionally applying only above a discount or at an amount (otherwise always). The
 * applicable levels are fixed at submission; each approval advances one level; one person cannot approve two levels of
 * the same submission; the last approval completes it and any rejection ends it. Without levels, one approval by any
 * approver is needed. Approvers of the current level are notified on submission and on advancing, the submitter on
 * the final decision; every step is recorded in an append-only history and audited.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { ApprovalAction, ApprovalStatus, NotificationType, QuoteStatus, UserRole } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, can, requirePermission, ROLE_PERMISSIONS, visible } from '../permissions';
import { optionalText, requiredText, type Page } from '../validation';
import { BASE_CURRENCY, ratesOn, toBase } from './exchange-rates';

/** 百分比：0–100，最多 2 位小数 / percent 0–100, ≤ 2 decimals */
const percent = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Invalid percent'))
  .refine((v) => Number(v) <= 100, 'At most 100');
/** 金额：非负，最多 16 位整数、2 位小数 / amount: non-negative, ≤ 16 integer and 2 decimal digits */
const money = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'Invalid amount'));

/** 审批级别 / an approval level */
const levelSchema = z.strictObject({
  name: requiredText(50),
  approverRole: z.enum(['ADMIN', 'MANAGER']),
  minDiscountPercent: percent.nullable().default(null),
  minTotal: money.nullable().default(null),
});

/** 保存审批规则 / save the approval policy */
export const approvalSettingsSchema = z
  .strictObject({ enabled: z.boolean(), maxDiscountPercent: percent.nullable(), minTotal: money.nullable(), levels: z.array(levelSchema).max(5).default([]) })
  .refine((v) => !v.enabled || v.maxDiscountPercent !== null || v.minTotal !== null, { path: ['enabled'], message: 'no_criteria' });
/** 提交 / submit */
export const approvalSubmitSchema = z.strictObject({ comment: optionalText(500) });
/** 审批 / decide */
export const approvalDecisionSchema = z
  .strictObject({ decision: z.enum(['APPROVE', 'REJECT']), comment: optionalText(500) })
  .refine((v) => v.decision === 'APPROVE' || !!v.comment, { path: ['comment'], message: 'required' });
/** 列表 / list */
export const approvalListSchema = z.strictObject({
  scope: z.enum(['pending', 'mine']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * 读取审批规则（未设置时为默认：不启用）。
 * Read the approval policy (defaults to disabled).
 */
export async function getApprovalSettings(ctx: AuthContext, client: Prisma.TransactionClient = prisma) {
  const row = await client.quoteApprovalSettings.findUnique({ where: { organizationId: ctx.organizationId }, include: { updatedBy: { select: { id: true, name: true } } } });
  const levels = await client.quoteApprovalLevel.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { position: 'asc' } });
  return {
    enabled: row?.enabled ?? false,
    maxDiscountPercent: row?.maxDiscountPercent?.toString() ?? null,
    minTotal: row?.minTotal?.toString() ?? null,
    levels: levels.map((l) => ({ name: l.name, approverRole: l.approverRole as 'ADMIN' | 'MANAGER', minDiscountPercent: l.minDiscountPercent?.toString() ?? null, minTotal: l.minTotal?.toString() ?? null })),
    baseCurrency: BASE_CURRENCY,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/**
 * 保存审批规则并写审计（已提交的审批不受影响）。
 * Save the policy (audited); requests already submitted are unaffected.
 */
export async function saveApprovalSettings(ctx: AuthContext, input: z.infer<typeof approvalSettingsSchema>) {
  requirePermission(ctx, 'approval.manage');
  const before = await getApprovalSettings(ctx);
  await prisma.$transaction(async (tx) => {
    const { levels, ...policy } = input;
    await tx.quoteApprovalSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...policy, updatedById: ctx.userId },
      update: { ...policy, updatedById: ctx.userId },
    });
    // 级别整体替换（已提交的审批使用提交时的快照，不受影响）/ levels are replaced (submitted requests keep their snapshot)
    await tx.quoteApprovalLevel.deleteMany({ where: { organizationId: ctx.organizationId } });
    if (levels.length) await tx.quoteApprovalLevel.createMany({ data: levels.map((l, position) => ({ organizationId: ctx.organizationId, position, ...l })) });
    const after = await getApprovalSettings(ctx, tx);
    const fields: Record<string, unknown> = Object.fromEntries(
      (['enabled', 'maxDiscountPercent', 'minTotal'] as const).filter((k) => before[k] !== after[k]).map((k) => [k, [before[k], after[k]]]),
    );
    const levelText = (l: (typeof after.levels)[number]) => `${l.name}:${l.approverRole}${l.minDiscountPercent !== null ? ` discount>${l.minDiscountPercent}` : ''}${l.minTotal !== null ? ` total>=${l.minTotal}` : ''}`;
    if (JSON.stringify(before.levels) !== JSON.stringify(after.levels)) fields.levels = [before.levels.map(levelText), after.levels.map(levelText)];
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'approval.settings', entityType: 'approval', entityId: null, changes: { fields } });
  });
  return getApprovalSettings(ctx);
}

/** 需要审批的原因（如 discount:20>15、total:1200000.00>=1000000、total:no_rate）/ reasons approval is needed */
export type Reasons = string[];

/**
 * 计算报价单是否需要审批（按当前明细与当天汇率）。
 * Work out whether a quote needs approval (current lines, today's rate).
 */
export async function approvalReasons(
  client: Prisma.TransactionClient,
  organizationId: string,
  quote: { currency: string; total: Prisma.Decimal; lines: { discountPercent: Prisma.Decimal }[] },
  now = new Date(),
): Promise<Reasons> {
  const settings = await client.quoteApprovalSettings.findUnique({ where: { organizationId } });
  if (!settings?.enabled) return [];
  const reasons: Reasons = [];
  if (settings.maxDiscountPercent !== null) {
    const max = quote.lines.reduce((m, l) => (l.discountPercent.gt(m) ? l.discountPercent : m), new Prisma.Decimal(0));
    if (max.gt(settings.maxDiscountPercent)) reasons.push(`discount:${max.toString()}>${settings.maxDiscountPercent.toString()}`);
  }
  if (settings.minTotal !== null) {
    const rate = (await ratesOn(organizationId, now, client)).get(quote.currency);
    if (!rate) reasons.push('total:no_rate');
    else {
      const base = toBase(quote.total, rate);
      if (base.gte(settings.minTotal)) reasons.push(`total:${base.toFixed(2)}>=${settings.minTotal.toString()}`);
    }
  }
  return reasons;
}

/** 审批级别快照 / an approval level snapshot */
export interface Step {
  name: string | null;
  /** 审批角色；为空表示任一审批人 / approver role; null = any approver */
  role: 'ADMIN' | 'MANAGER' | null;
}

/**
 * 计算报价单适用的审批级别（按顺序）；没有设置或都不适用时为一级（任一审批人）。
 * Work out the levels that apply to a quote, in order; none configured or applicable gives one level (any approver).
 */
export async function approvalSteps(
  client: Prisma.TransactionClient,
  organizationId: string,
  quote: { currency: string; total: Prisma.Decimal; lines: { discountPercent: Prisma.Decimal }[] },
  now = new Date(),
): Promise<Step[]> {
  const levels = await client.quoteApprovalLevel.findMany({ where: { organizationId }, orderBy: { position: 'asc' } });
  const maxDiscount = quote.lines.reduce((m, l) => (l.discountPercent.gt(m) ? l.discountPercent : m), new Prisma.Decimal(0));
  let base: Prisma.Decimal | null | undefined;
  const steps: Step[] = [];
  for (const l of levels) {
    let applies = l.minDiscountPercent === null && l.minTotal === null;
    if (l.minDiscountPercent !== null && maxDiscount.gt(l.minDiscountPercent)) applies = true;
    if (l.minTotal !== null && !applies) {
      if (base === undefined) {
        const rate = (await ratesOn(organizationId, now, client)).get(quote.currency);
        base = rate ? toBase(quote.total, rate) : null;
      }
      // 没有汇率时按需要该级审批处理 / without a rate the level applies
      applies = base === null || base.gte(l.minTotal);
    }
    if (applies) steps.push({ name: l.name, role: l.approverRole as 'ADMIN' | 'MANAGER' });
  }
  return steps.length ? steps : [{ name: null, role: null }];
}

/** 某级别的审批角色 / roles allowed at a level */
const rolesFor = (step: Step | undefined): UserRole[] => (step?.role === 'ADMIN' ? [UserRole.ADMIN] : step?.role === 'MANAGER' ? [UserRole.ADMIN, UserRole.MANAGER] : APPROVER_ROLES);

/** 读取快照 / read a snapshot */
const stepsOf = (raw: Prisma.JsonValue | null): Step[] => (Array.isArray(raw) ? (raw as unknown as Step[]) : [{ name: null, role: null }]);

/**
 * 本次提交中已批准过某级别的人（最近一次提交之后）。
 * People who already approved a level of the current submission (after the latest submit).
 */
async function priorApprovers(client: Prisma.TransactionClient, organizationId: string, quoteId: string): Promise<Set<string>> {
  const rows = await client.quoteApproval.findMany({ where: { organizationId, quoteId, action: { in: [ApprovalAction.SUBMIT, ApprovalAction.APPROVE] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { action: true, actorId: true } });
  const out = new Set<string>();
  for (const r of rows) {
    if (r.action === ApprovalAction.SUBMIT) break;
    out.add(r.actorId);
  }
  return out;
}

/**
 * 通知某级别的审批人（不含提交人与本次已批准过的人）。
 * Notify approvers of a level (not the submitter or people who already approved this submission).
 */
async function notifyLevel(tx: Prisma.TransactionClient, ctx: AuthContext, quote: { id: string; dealId: string; quoteNumber: string; subject: string }, step: Step, exclude: Set<string>) {
  const approvers = await tx.user.findMany({ where: { organizationId: ctx.organizationId, isActive: true, role: { in: rolesFor(step) }, id: { notIn: [...exclude] } }, select: { id: true } });
  if (approvers.length) {
    await tx.notification.createMany({
      data: approvers.map((u) => ({ organizationId: ctx.organizationId, userId: u.id, type: NotificationType.APPROVAL_REQUEST, actorId: ctx.userId, dealId: quote.dealId, title: `${quote.quoteNumber} · ${quote.subject}`.slice(0, 200) })),
    });
  }
  return approvers.length;
}

/** 有审批权限的角色 / roles that may approve */
const APPROVER_ROLES = (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((r) => ROLE_PERMISSIONS[r].includes('quote.approve'));

/**
 * 读取可见报价单（含明细与商机负责人）；不可见 404。
 * Load a visible quote with lines and the deal owner; 404 otherwise.
 */
async function loadQuote(ctx: AuthContext, id: string, client: Prisma.TransactionClient = prisma) {
  const quote = await client.quote.findFirst({
    where: { id, organizationId: ctx.organizationId, deal: visible(ctx) },
    include: { lines: { select: { discountPercent: true } }, deal: { select: { id: true, ownerId: true } } },
  });
  if (!quote) throw notFound();
  return quote;
}

/** 最近一次提交人 / the latest submitter */
async function lastSubmitter(client: Prisma.TransactionClient, organizationId: string, quoteId: string): Promise<string | null> {
  const row = await client.quoteApproval.findFirst({ where: { organizationId, quoteId, action: ApprovalAction.SUBMIT }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { actorId: true } });
  return row?.actorId ?? null;
}

/** 状态已被并发修改 / changed concurrently */
const changed = () => new ApiError(409, 'CONFLICT', 'Quote approval was changed concurrently', { approvalStatus: ['changed'] });

/**
 * 提交审批：草稿且需要审批；通知其他审批人。
 * Submit a draft that needs approval; other approvers are notified.
 */
export async function submitApproval(ctx: AuthContext, id: string, input: z.infer<typeof approvalSubmitSchema>) {
  const quote = await loadQuote(ctx, id);
  assertCanUpdate(ctx, quote.deal);
  if (quote.status !== QuoteStatus.DRAFT) throw new ApiError(409, 'CONFLICT', 'Only drafts can be submitted', { status: ['not_draft'] });
  if (quote.approvalStatus === ApprovalStatus.PENDING) throw new ApiError(409, 'CONFLICT', 'Already pending approval', { approvalStatus: ['pending'] });
  if (quote.approvalStatus === ApprovalStatus.APPROVED) throw new ApiError(409, 'CONFLICT', 'Already approved', { approvalStatus: ['approved'] });
  return prisma.$transaction(async (tx) => {
    const reasons = await approvalReasons(tx, ctx.organizationId, quote);
    if (!reasons.length) throw new ApiError(409, 'CONFLICT', 'Approval is not required', { approvalStatus: ['not_required'] });
    // 提交时确定审批级别并保存快照 / fix the levels at submission
    const steps = await approvalSteps(tx, ctx.organizationId, quote);
    const n = await tx.quote.updateMany({
      where: { id, status: QuoteStatus.DRAFT, OR: [{ approvalStatus: null }, { approvalStatus: ApprovalStatus.REJECTED }] },
      data: { approvalStatus: ApprovalStatus.PENDING, approvalReasons: reasons, approvalStep: 0, approvalSteps: steps as unknown as Prisma.InputJsonValue },
    });
    if (n.count !== 1) throw changed();
    await tx.quoteApproval.create({ data: { organizationId: ctx.organizationId, quoteId: id, action: ApprovalAction.SUBMIT, actorId: ctx.userId, comment: input.comment, reasons } });
    await audit(tx, { ...by(ctx), action: 'quote.approval_submit', entityType: 'quote', entityId: id, changes: { reasons, levels: steps.map((s) => s.name ?? '*'), comment: input.comment ? '[redacted]' : null } });
    const notified = await notifyLevel(tx, ctx, quote, steps[0]!, new Set([ctx.userId]));
    return { approvalStatus: ApprovalStatus.PENDING, reasons, steps, notified };
  });
}

/**
 * 撤回待审批（提交人或审批人）。
 * Recall a pending request (the submitter or an approver).
 */
export async function recallApproval(ctx: AuthContext, id: string) {
  const quote = await loadQuote(ctx, id);
  if (quote.approvalStatus !== ApprovalStatus.PENDING) throw new ApiError(409, 'CONFLICT', 'Not pending approval', { approvalStatus: ['not_pending'] });
  const submitter = await lastSubmitter(prisma, ctx.organizationId, id);
  if (submitter !== ctx.userId && !can(ctx, 'quote.approve')) throw new ApiError(403, 'FORBIDDEN', 'Permission denied', { permission: ['quote.approve'] });
  await prisma.$transaction(async (tx) => {
    const n = await tx.quote.updateMany({ where: { id, approvalStatus: ApprovalStatus.PENDING }, data: { approvalStatus: null, approvalReasons: Prisma.DbNull, approvalStep: null, approvalSteps: Prisma.DbNull } });
    if (n.count !== 1) throw changed();
    await tx.quoteApproval.create({ data: { organizationId: ctx.organizationId, quoteId: id, action: ApprovalAction.RECALL, actorId: ctx.userId } });
    await audit(tx, { ...by(ctx), action: 'quote.approval_recall', entityType: 'quote', entityId: id });
  });
  return { approvalStatus: null };
}

/**
 * 审批（批准或驳回，驳回须填写意见）；不能审批自己提交的报价单；通知提交人。
 * Approve or reject (rejections need a comment); nobody decides their own submission; the submitter is notified.
 */
export async function decideApproval(ctx: AuthContext, id: string, input: z.infer<typeof approvalDecisionSchema>) {
  requirePermission(ctx, 'quote.approve');
  const quote = await loadQuote(ctx, id);
  if (quote.approvalStatus !== ApprovalStatus.PENDING) throw new ApiError(409, 'CONFLICT', 'Not pending approval', { approvalStatus: ['not_pending'] });
  const submitter = await lastSubmitter(prisma, ctx.organizationId, id);
  if (submitter === ctx.userId) throw new ApiError(403, 'FORBIDDEN', 'Cannot approve your own submission', { approvalStatus: ['self_approval'] });
  const steps = stepsOf(quote.approvalSteps);
  const step = quote.approvalStep ?? 0;
  // 当前级别的审批角色；同一人不能批准同一次提交的两个级别 / the level's role; one person cannot approve two levels
  if (!rolesFor(steps[step]).includes(ctx.role)) throw new ApiError(403, 'FORBIDDEN', 'Not an approver for this level', { approvalStatus: ['not_your_level'] });
  const prior = await priorApprovers(prisma, ctx.organizationId, id);
  if (prior.has(ctx.userId)) throw new ApiError(403, 'FORBIDDEN', 'Already approved a level of this submission', { approvalStatus: ['already_approved_level'] });
  const last = step >= steps.length - 1;
  const status = input.decision === 'REJECT' ? ApprovalStatus.REJECTED : last ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING;
  await prisma.$transaction(async (tx) => {
    // 条件更新：仍在同一级别才能审批（并发审批只有一个成功）/ conditional on the same level (concurrent decisions: one wins)
    const n = await tx.quote.updateMany({
      where: { id, approvalStatus: ApprovalStatus.PENDING, approvalStep: step },
      data: status === ApprovalStatus.PENDING ? { approvalStep: step + 1 } : { approvalStatus: status, approvalStep: null },
    });
    if (n.count !== 1) throw changed();
    await tx.quoteApproval.create({
      data: { organizationId: ctx.organizationId, quoteId: id, action: input.decision === 'APPROVE' ? ApprovalAction.APPROVE : ApprovalAction.REJECT, actorId: ctx.userId, comment: input.comment, step },
    });
    await audit(tx, {
      ...by(ctx),
      action: input.decision === 'APPROVE' ? 'quote.approve' : 'quote.reject',
      entityType: 'quote',
      entityId: id,
      changes: { step: step + 1, of: steps.length, level: steps[step]?.name ?? null, comment: input.comment ? '[redacted]' : null },
    });
    // 还有下一级：通知下一级审批人 / more levels: notify the next level
    if (status === ApprovalStatus.PENDING) {
      await notifyLevel(tx, ctx, quote, steps[step + 1]!, new Set([...prior, ctx.userId, ...(submitter ? [submitter] : [])]));
      return;
    }
    if (submitter) {
      const active = await tx.user.findFirst({ where: { id: submitter, organizationId: ctx.organizationId, isActive: true }, select: { id: true } });
      if (active) {
        await tx.notification.create({
          data: { organizationId: ctx.organizationId, userId: submitter, type: NotificationType.APPROVAL_DECIDED, actorId: ctx.userId, dealId: quote.dealId, title: `${quote.quoteNumber} · ${quote.subject}`.slice(0, 200) },
        });
      }
    }
  });
  return { approvalStatus: status, step: status === ApprovalStatus.PENDING ? step + 1 : null, steps };
}

/**
 * 报价单的审批历史（最新在前）；报价单不可见时 404。
 * A quote's approval history (newest first); 404 when the quote is not visible.
 */
export async function approvalHistory(ctx: AuthContext, id: string) {
  await loadQuote(ctx, id);
  const items = await prisma.quoteApproval.findMany({
    where: { organizationId: ctx.organizationId, quoteId: id },
    select: { id: true, action: true, comment: true, reasons: true, step: true, createdAt: true, actor: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return { items };
}

const listSelect = {
  id: true,
  quoteNumber: true,
  subject: true,
  status: true,
  currency: true,
  total: true,
  approvalStatus: true,
  approvalReasons: true,
  approvalStep: true,
  approvalSteps: true,
  updatedAt: true,
  deal: { select: { id: true, name: true, account: { select: { id: true, name: true } } } },
  approvals: {
    where: { action: { in: [ApprovalAction.SUBMIT, ApprovalAction.APPROVE] } },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 10,
    select: { action: true, createdAt: true, actor: { select: { id: true, name: true } } },
  },
} satisfies Prisma.QuoteSelect;

/**
 * 审批列表：pending = 待审批（需 quote.approve；含能否审批的标记）；mine = 我提交过的报价单（含当前审批状态）。
 * Approval lists: pending (quote.approve; with whether I may decide) and mine (quotes I submitted, with their status).
 */
export async function listApprovals(ctx: AuthContext, query: z.infer<typeof approvalListSchema>): Promise<Page<unknown>> {
  let where: Prisma.QuoteWhereInput;
  if (query.scope === 'pending') {
    requirePermission(ctx, 'quote.approve');
    where = { organizationId: ctx.organizationId, approvalStatus: ApprovalStatus.PENDING, deal: visible(ctx) };
  } else {
    where = { organizationId: ctx.organizationId, approvals: { some: { action: ApprovalAction.SUBMIT, actorId: ctx.userId } }, deal: visible(ctx) };
  }
  const [rows, total] = await prisma.$transaction([
    prisma.quote.findMany({ where, select: listSelect, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.quote.count({ where }),
  ]);
  const items = rows.map(({ approvals, ...q }) => {
    const i = approvals.findIndex((a) => a.action === ApprovalAction.SUBMIT);
    const submitted = i >= 0 ? approvals[i]! : null;
    // 本次提交中已批准过的人 / people who approved this submission already
    const approvedBy = new Set(approvals.slice(0, i < 0 ? approvals.length : i).map((a) => a.actor.id));
    const steps = stepsOf(q.approvalSteps);
    const step = q.approvalStep ?? 0;
    const canDecide =
      q.approvalStatus === ApprovalStatus.PENDING && can(ctx, 'quote.approve') && submitted?.actor.id !== ctx.userId && !approvedBy.has(ctx.userId) && rolesFor(steps[step]).includes(ctx.role);
    return { ...q, submittedBy: submitted?.actor ?? null, submittedAt: submitted?.createdAt ?? null, canDecide };
  });
  return { items, total, page: query.page, pageSize: query.pageSize };
}
