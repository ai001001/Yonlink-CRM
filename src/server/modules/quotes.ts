/**
 * 报价单应用服务。
 * - 由商机生成：复制商机当前产品明细为快照（不引用产品），报价单号按组织、按年连续编号（QT-2026-0001）。
 * - 小计 = 明细合计；税额 = 小计 × 税率%（四舍五入到分）；总计 = 小计 + 税额。
 * - 状态：草稿 → 已发送 → 已接受 / 已拒绝；已发送可退回草稿。仅草稿可修改、同步明细、删除。
 * - 可见与编辑权限跟随所属商机（销售代表只能操作自己负责商机的报价单）。
 * Quotes service: generated from a deal by snapshotting its line items; per-organization yearly numbering;
 * subtotal = sum of lines, tax = subtotal × rate (half-up to cents), total = subtotal + tax;
 * DRAFT → SENT → ACCEPTED/REJECTED (SENT may return to DRAFT); only drafts can be edited, synced or deleted;
 * visibility and edit rights follow the deal.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { QuoteStatus } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, visible } from '../permissions';
import { containsText, listQuery, optionalText, requiredText, type Page } from '../validation';
import { dateOnly } from './deals';

/** 税率：0–100，最多 2 位小数 / tax rate: 0–100, ≤ 2 decimals */
const taxPercent = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Invalid tax rate'))
  .refine((v) => Number(v) <= 100, 'Tax rate must be at most 100');

const editable = {
  subject: requiredText(200),
  validUntil: dateOnly.nullish().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null)),
  taxPercent,
  terms: optionalText(5000),
  notes: optionalText(5000),
};

/** 由商机生成报价单 / Create a quote from a deal */
export const quoteCreateSchema = z.strictObject({
  dealId: z.uuid(),
  /** 不填时使用商机名称 / defaults to the deal name */
  subject: editable.subject.optional(),
  validUntil: editable.validUntil,
  taxPercent: taxPercent.default('0'),
  terms: editable.terms,
  notes: editable.notes,
});
/** 修改草稿 / Update a draft */
export const quoteUpdateSchema = z.strictObject(editable).partial();
/** 状态变更 / Status change */
export const quoteStatusSchema = z.strictObject({ status: z.enum(QuoteStatus) });
/** 列表查询 / List query */
export const quoteListSchema = listQuery.extend({
  status: z.enum(QuoteStatus).optional(),
  dealId: z.uuid().optional(),
});

/** 允许的状态流转 / Allowed status transitions */
export const TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  DRAFT: ['SENT'],
  SENT: ['ACCEPTED', 'REJECTED', 'DRAFT'],
  ACCEPTED: [],
  REJECTED: [],
};

const listInclude = {
  deal: { select: { id: true, name: true, ownerId: true, account: { select: { id: true, name: true } } } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.QuoteInclude;

const detailInclude = {
  deal: {
    select: {
      id: true,
      name: true,
      ownerId: true,
      stage: true,
      owner: { select: { id: true, name: true } },
      account: { select: { id: true, name: true, phone: true, address: true } },
    },
  },
  createdBy: { select: { id: true, name: true } },
  organization: { select: { name: true } },
  lines: { orderBy: { position: 'asc' } },
} satisfies Prisma.QuoteInclude;

/**
 * 计算税额与总计。
 * Compute the tax amount and total.
 */
export function quoteTotals(subtotal: Prisma.Decimal, rate: string | Prisma.Decimal) {
  const taxAmount = subtotal.mul(rate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { subtotal, taxAmount, total: subtotal.plus(taxAmount) };
}

/**
 * 读取可见商机及其明细（含产品单位）。
 * Load a visible deal with its line items (and product units).
 */
async function dealWithItems(ctx: AuthContext, dealId: string) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, ...visible(ctx) },
    select: {
      id: true,
      name: true,
      ownerId: true,
      currency: true,
      lineItems: { include: { product: { select: { unit: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!deal) throw notFound();
  return deal;
}

/**
 * 把商机明细转为报价单明细快照。
 * Turn deal line items into quote line snapshots.
 */
function snapshotLines(organizationId: string, quoteId: string, items: Awaited<ReturnType<typeof dealWithItems>>['lineItems']) {
  if (!items.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Deal has no line items', { dealId: ['no_items'] });
  const lines = items.map((i, n) => ({
    organizationId,
    quoteId,
    position: n + 1,
    productSku: i.productSku,
    productName: i.productName,
    unit: i.product.unit,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    discountPercent: i.discountPercent,
    lineTotal: i.lineTotal,
  }));
  const subtotal = lines.reduce((s, l) => s.plus(l.lineTotal), new Prisma.Decimal(0));
  return { lines, subtotal };
}

/**
 * 在事务内生成下一个报价单号（按组织加事务级咨询锁，避免并发重号）。
 * Allocate the next quote number inside the transaction (per-organization advisory lock prevents duplicates).
 */
async function nextNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`quote:${organizationId}`}, 0))`;
  const prefix = `QT-${new Date().getUTCFullYear()}-`;
  // 起始位置必须显式转为 int：未定型参数会被解析为 text，substring(text FROM text) 是正则版本
  // the start position must be cast to int: an untyped parameter resolves to text, and substring(text FROM text) is the regex form
  const start = prefix.length + 1;
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT max(substring(quote_number FROM ${start}::int)::int) AS max
    FROM quotes WHERE organization_id = ${organizationId}::uuid AND quote_number LIKE ${`${prefix}%`} AND substring(quote_number FROM ${start}::int) ~ '^[0-9]+$'`;
  return `${prefix}${String((rows[0]?.max ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * 分页搜索报价单（报价单号、主题、商机、客户），只含可见商机的报价单。
 * Search quotes (number, subject, deal, account) on visible deals, paginated.
 */
export async function listQuotes(ctx: AuthContext, query: z.infer<typeof quoteListSchema>): Promise<Page<unknown>> {
  const where: Prisma.QuoteWhereInput = { AND: [{ organizationId: ctx.organizationId, deal: visible(ctx) }, { status: query.status, dealId: query.dealId }] };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ quoteNumber: c }, { subject: c }, { deal: { name: c } }, { deal: { account: { name: c } } }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.quote.findMany({ where, include: listInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.quote.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 报价单详情（含明细、商机、客户、组织名称，供打印）；不可见 404。
 * Quote detail with lines, deal, account and organization name (for printing); 404 when not visible.
 */
export async function getQuote(ctx: AuthContext, id: string) {
  const quote = await prisma.quote.findFirst({ where: { id, organizationId: ctx.organizationId, deal: visible(ctx) }, include: detailInclude });
  if (!quote) throw notFound();
  return quote;
}

/**
 * 读取报价单并校验编辑权限；需要草稿状态时校验状态。
 * Load a quote, check edit rights and optionally require the draft status.
 */
async function requireEditable(ctx: AuthContext, id: string, draftOnly: boolean) {
  const quote = await getQuote(ctx, id);
  assertCanUpdate(ctx, quote.deal);
  if (draftOnly && quote.status !== QuoteStatus.DRAFT) throw new ApiError(409, 'CONFLICT', 'Only drafts can be changed', { status: ['not_draft'] });
  return quote;
}

/**
 * 由商机生成报价单（商机须有产品明细）。
 * Create a quote from a deal (the deal must have line items).
 */
export async function createQuote(ctx: AuthContext, input: z.infer<typeof quoteCreateSchema>) {
  const deal = await dealWithItems(ctx, input.dealId);
  assertCanUpdate(ctx, deal);
  const id = crypto.randomUUID();
  const { lines, subtotal } = snapshotLines(ctx.organizationId, id, deal.lineItems);
  await prisma.$transaction(async (tx) => {
    const quote = await tx.quote.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        dealId: deal.id,
        quoteNumber: await nextNumber(tx, ctx.organizationId),
        subject: input.subject ?? deal.name,
        currency: deal.currency,
        validUntil: input.validUntil,
        taxPercent: input.taxPercent,
        terms: input.terms,
        notes: input.notes,
        createdById: ctx.userId,
        ...quoteTotals(subtotal, input.taxPercent),
      },
    });
    await tx.quoteLineItem.createMany({ data: lines });
    await audit(tx, { ...by(ctx), action: 'quote.create', entityType: 'quote', entityId: quote.id, changes: { after: snapshot('quote', quote), lines: lines.length } });
  });
  return getQuote(ctx, id);
}

/**
 * 修改草稿（主题、有效期、税率、条款、备注），税率变化时重算税额与总计。
 * Update a draft; tax and total are recalculated when the rate changes.
 */
export async function updateQuote(ctx: AuthContext, id: string, input: z.infer<typeof quoteUpdateSchema>) {
  const current = await requireEditable(ctx, id, true);
  await prisma.$transaction(async (tx) => {
    const quote = await tx.quote.update({
      where: { id },
      data: { ...input, ...(input.taxPercent !== undefined ? quoteTotals(current.subtotal, input.taxPercent) : {}) },
    });
    const fields = diff('quote', current, quote);
    if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'quote.update', entityType: 'quote', entityId: id, changes: { fields } });
  });
  return getQuote(ctx, id);
}

/**
 * 草稿从商机重新同步产品明细（商机明细修改后使用）。
 * Re-sync a draft's lines from the deal's current line items.
 */
export async function syncQuote(ctx: AuthContext, id: string) {
  const current = await requireEditable(ctx, id, true);
  const deal = await dealWithItems(ctx, current.dealId);
  const { lines, subtotal } = snapshotLines(ctx.organizationId, id, deal.lineItems);
  await prisma.$transaction(async (tx) => {
    await tx.quoteLineItem.deleteMany({ where: { organizationId: ctx.organizationId, quoteId: id } });
    await tx.quoteLineItem.createMany({ data: lines });
    const quote = await tx.quote.update({ where: { id }, data: { currency: deal.currency, ...quoteTotals(subtotal, current.taxPercent) } });
    await audit(tx, {
      ...by(ctx),
      action: 'quote.sync_items',
      entityType: 'quote',
      entityId: id,
      changes: { lines: [current.lines.length, lines.length], fields: diff('quote', current, quote) },
    });
  });
  return getQuote(ctx, id);
}

/**
 * 变更状态（按流转规则；非法流转 409）。
 * Change the status following the transition rules (invalid transitions → 409).
 */
export async function changeQuoteStatus(ctx: AuthContext, id: string, input: z.infer<typeof quoteStatusSchema>) {
  const current = await requireEditable(ctx, id, false);
  if (!TRANSITIONS[current.status].includes(input.status)) {
    throw new ApiError(409, 'CONFLICT', 'Invalid status transition', { status: [`${current.status}->${input.status}`] });
  }
  const now = new Date();
  const data: Prisma.QuoteUpdateInput = { status: input.status };
  if (input.status === QuoteStatus.SENT) data.sentAt = now;
  if (input.status === QuoteStatus.ACCEPTED || input.status === QuoteStatus.REJECTED) data.decidedAt = now;
  if (input.status === QuoteStatus.DRAFT) data.sentAt = null;
  await prisma.$transaction(async (tx) => {
    // 条件更新防止并发重复流转 / conditional update guards against concurrent transitions
    const n = await tx.quote.updateMany({ where: { id, status: current.status }, data: data as Prisma.QuoteUpdateManyMutationInput });
    if (n.count !== 1) throw new ApiError(409, 'CONFLICT', 'Quote was changed concurrently', { status: ['changed'] });
    await audit(tx, { ...by(ctx), action: 'quote.status', entityType: 'quote', entityId: id, changes: { fields: { status: [current.status, input.status] } } });
  });
  return getQuote(ctx, id);
}

/**
 * 删除草稿报价单（已发送/已接受/已拒绝的报价单不能删除）。
 * Delete a draft quote (sent and decided quotes cannot be deleted).
 */
export async function deleteQuote(ctx: AuthContext, id: string): Promise<void> {
  const current = await requireEditable(ctx, id, true);
  await prisma.$transaction(async (tx) => {
    const n = await tx.quote.deleteMany({ where: { id, status: QuoteStatus.DRAFT } });
    if (n.count !== 1) throw new ApiError(409, 'CONFLICT', 'Only drafts can be changed', { status: ['not_draft'] });
    await audit(tx, { ...by(ctx), action: 'quote.delete', entityType: 'quote', entityId: id, changes: { before: snapshot('quote', current), lines: current.lines.length } });
  });
}
