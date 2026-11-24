/**
 * 商机竞争对手应用服务（对标 Zoho Competitors）。
 * - 名称在同一商机内唯一（不区分大小写，前后空格去除）；记录威胁程度、优势、劣势。
 * - 查看需能看到商机；增删改需能编辑商机；写操作在商机审计中记录（优势、劣势只记“已修改”）。
 * Deal competitors (cf. Zoho): name unique per deal (case-insensitive, trimmed) with threat level, strengths and
 * weaknesses. Viewing needs the deal to be visible; changes need edit rights on the deal and are audited on the
 * deal (strengths and weaknesses recorded as changed only).
 */
import { z } from 'zod';
import { CompetitorThreat, Prisma } from '@/generated/prisma/client';
import { audit, by, REDACTED } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { assertCanUpdate, visible } from '../permissions';
import { readableDeals, territoryReadScope } from './territory-rules';

/** 威胁程度取值 / Threat levels */
export const THREAT_LEVELS = Object.values(CompetitorThreat) as [CompetitorThreat, ...CompetitorThreat[]];

/** 可空长文本：空白视为清空 / nullable long text: blank clears it */
const longText = z
  .string()
  .trim()
  .max(5000)
  .nullable()
  .transform((v) => v || null);

/** 新增竞争对手 / Add a competitor */
export const competitorCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  threatLevel: z.enum(THREAT_LEVELS).default('MEDIUM'),
  strengths: longText.optional(),
  weaknesses: longText.optional(),
});
/** 修改竞争对手 / Update a competitor */
export const competitorUpdateSchema = z
  .strictObject({ name: z.string().trim().min(1).max(100), threatLevel: z.enum(THREAT_LEVELS), strengths: longText, weaknesses: longText })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'No changes');

/** 威胁程度排序（高在前）/ threat order, high first */
const THREAT_ORDER: Record<CompetitorThreat, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * 读取可见商机。
 * Load a visible deal.
 */
async function requireDeal(ctx: AuthContext, dealId: string) {
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id: dealId }, readableDeals(ctx, await territoryReadScope(ctx))] }, select: { id: true, ownerId: true } });
  if (!deal) throw notFound();
  return deal;
}

/**
 * 名称重复 → 409。
 * Duplicate name → 409.
 */
function conflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ApiError(409, 'CONFLICT', 'Competitor already listed', { name: ['duplicate'] });
  }
  throw err;
}

/**
 * 商机的竞争对手（威胁高的在前）。
 * Competitors of a deal, highest threat first.
 */
export async function listCompetitors(ctx: AuthContext, dealId: string) {
  await requireDeal(ctx, dealId);
  const items = await prisma.dealCompetitor.findMany({ where: { organizationId: ctx.organizationId, dealId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { items: items.sort((a, b) => THREAT_ORDER[a.threatLevel] - THREAT_ORDER[b.threatLevel]) };
}

/**
 * 新增竞争对手。
 * Add a competitor.
 */
export async function addCompetitor(ctx: AuthContext, dealId: string, input: z.infer<typeof competitorCreateSchema>) {
  assertCanUpdate(ctx, await requireDeal(ctx, dealId));
  try {
    return await prisma.$transaction(async (tx) => {
      const item = await tx.dealCompetitor.create({
        data: { organizationId: ctx.organizationId, dealId, name: input.name, threatLevel: input.threatLevel, strengths: input.strengths ?? null, weaknesses: input.weaknesses ?? null },
      });
      await audit(tx, { ...by(ctx), action: 'deal.add_competitor', entityType: 'deal', entityId: dealId, changes: { competitor: item.name, threatLevel: item.threatLevel } });
      return item;
    });
  } catch (err) {
    conflict(err);
  }
}

/**
 * 读取竞争对手（所属商机必须可见）。
 * Load a competitor whose deal is visible.
 */
async function requireCompetitor(ctx: AuthContext, id: string) {
  const item = await prisma.dealCompetitor.findFirst({ where: { id, organizationId: ctx.organizationId, deal: visible(ctx) }, include: { deal: { select: { id: true, ownerId: true } } } });
  if (!item) throw notFound();
  return item;
}

/**
 * 修改竞争对手。
 * Update a competitor.
 */
export async function updateCompetitor(ctx: AuthContext, id: string, input: z.infer<typeof competitorUpdateSchema>) {
  const { deal, ...current } = await requireCompetitor(ctx, id);
  assertCanUpdate(ctx, deal);
  try {
    return await prisma.$transaction(async (tx) => {
      const { count } = await tx.dealCompetitor.updateMany({ where: { id, organizationId: ctx.organizationId }, data: input });
      if (!count) throw notFound();
      const item = await tx.dealCompetitor.findUniqueOrThrow({ where: { id } });
      const fields: Record<string, [unknown, unknown]> = {};
      if (item.name !== current.name) fields.competitorName = [current.name, item.name];
      if (item.threatLevel !== current.threatLevel) fields.threatLevel = [current.threatLevel, item.threatLevel];
      // 长文本只记录“已修改” / long text recorded as changed only
      if (item.strengths !== current.strengths) fields.strengths = [REDACTED, REDACTED];
      if (item.weaknesses !== current.weaknesses) fields.weaknesses = [REDACTED, REDACTED];
      if (Object.keys(fields).length) {
        await audit(tx, { ...by(ctx), action: 'deal.update_competitor', entityType: 'deal', entityId: current.dealId, changes: { competitor: current.name, fields } });
      }
      return item;
    });
  } catch (err) {
    conflict(err);
  }
}

/**
 * 删除竞争对手。
 * Remove a competitor.
 */
export async function removeCompetitor(ctx: AuthContext, id: string): Promise<void> {
  const { deal, ...current } = await requireCompetitor(ctx, id);
  assertCanUpdate(ctx, deal);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.dealCompetitor.deleteMany({ where: { id, organizationId: ctx.organizationId } });
    if (!count) throw notFound();
    await audit(tx, { ...by(ctx), action: 'deal.remove_competitor', entityType: 'deal', entityId: current.dealId, changes: { competitor: current.name, threatLevel: current.threatLevel } });
  });
}
