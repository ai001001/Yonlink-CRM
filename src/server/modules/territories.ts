/**
 * 区域管理（对标 Zoho Territory Management）：按地区或行业把客户划入销售区域，查看各区域的客户与商机业绩。
 * - 区域为树形，最多 3 级、每组织最多 100 个；可设负责人与成员（组织内的启用用户）。
 * - 规则：按客户字段（名称、行业、地址、电话、网站、负责人）设置最多 10 个条件，全部满足或任一满足；优先级小的先匹配，
 *   同优先级按名称；没有条件的区域不自动分配。客户新建、编辑时按规则自动分配；“重新分配”对全部非手工指定的客户重算。
 * - 手工指定：有 territory.manage 的用户可在客户上指定区域或“无区域”，此后规则不再覆盖；指定为 AUTO 恢复自动分配。
 * - 删除区域：有下级时拒绝；其中的客户变为无区域并恢复自动分配。
 * - 统计按当前用户可见的客户与商机计算（销售只统计自己的），含下级区域；金额按今天的汇率折合本币。
 * - 维护需 territory.manage（管理员、经理）并写审计；所有用户可读取区域列表（用于筛选与显示）。
 * - 不改变记录可见范围：销售仍只能看到自己负责的记录。
 * Territory management (cf. Zoho Territory Management): group accounts into sales territories by region or industry
 * and review account and deal results per territory. Territories form a tree of up to 3 levels (100 per organization)
 * with an optional manager and members (active users of the organization). Rules hold up to 10 conditions on account
 * fields (name, industry, address, phone, website, owner) matched ALL or ANY; lower priority matches first, ties by
 * name; territories without conditions never auto-assign. Accounts are assigned on create and edit; "apply rules"
 * recomputes every account not set by hand. Users with territory.manage may set a territory (or none) by hand, which
 * rules then leave alone; AUTO returns to automatic assignment. Deleting a territory with children is refused; its
 * accounts become unassigned and automatic. Statistics count accounts and deals visible to the caller (sales see their
 * own), include descendants, and convert amounts to the base currency at today's rates. Maintenance needs
 * territory.manage (admins, managers) and is audited; everyone may list territories. Record visibility is unchanged.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { TerritoryMatch } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { can, requirePermission } from '../permissions';
import { optionalText, requiredText } from '../validation';
import { BASE_CURRENCY, ratesOn, sumInBase } from './exchange-rates';
import { matchTerritory, ruleTerritories, TERRITORY_FIELDS } from './territory-rules';
import { checkCondition, conditionSchema, type Condition } from './workflows';

/** 每组织最多区域数 / max territories per organization */
export const MAX_TERRITORIES = 100;
/** 最多层级 / max tree depth */
export const MAX_DEPTH = 3;
/** 重新分配每批客户数 / accounts per batch when applying rules */
const APPLY_BATCH = 1000;

const fields = {
  name: requiredText(100),
  description: optionalText(500),
  parentId: z.uuid().nullish().transform((v) => v ?? null),
  managerId: z.uuid().nullish().transform((v) => v ?? null),
  priority: z.number().int().min(1).max(999).default(100),
  match: z.enum(TerritoryMatch).default(TerritoryMatch.ALL),
  conditions: z.array(conditionSchema).max(10).default([]),
  memberIds: z.array(z.uuid()).max(200).default([]),
};

/** 校验条件 / validate conditions */
function checkConditions(conditions: Condition[] | undefined, ctx: z.RefinementCtx) {
  conditions?.forEach((c, i) => checkCondition(TERRITORY_FIELDS, c, (field, message) => ctx.addIssue({ code: 'custom', path: ['conditions', i, field], message })));
}

/** 新建 / create */
export const territoryCreateSchema = z.strictObject(fields).superRefine((v, ctx) => checkConditions(v.conditions, ctx));
/** 修改（只改提交的字段）/ update (only the fields sent) */
export const territoryUpdateSchema = z
  .strictObject({
    name: requiredText(100),
    description: optionalText(500),
    parentId: z.uuid().nullable(),
    managerId: z.uuid().nullable(),
    priority: z.number().int().min(1).max(999),
    match: z.enum(TerritoryMatch),
    conditions: z.array(conditionSchema).max(10),
    memberIds: z.array(z.uuid()).max(200),
  })
  .partial()
  .superRefine((v, ctx) => checkConditions(v.conditions, ctx));

const lockKey = (org: string) => `territory:${org}`;
const select = {
  id: true,
  parentId: true,
  name: true,
  description: true,
  managerId: true,
  priority: true,
  match: true,
  conditions: true,
  manager: { select: { id: true, name: true } },
  members: { select: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.TerritorySelect;
type Row = Prisma.TerritoryGetPayload<{ select: typeof select }>;
/** 区域（成员展开为用户）/ territory with members flattened to users */
const shape = ({ members, ...t }: Row) => ({ ...t, members: members.map((m) => m.user) });

/** 统计行 / statistics row */
interface StatRow {
  territory_id: string | null;
  currency: string | null;
  open_count: number;
  open_amount: Prisma.Decimal | null;
  won_count: number;
  won_amount: Prisma.Decimal | null;
}

/** 列表查询：options 只返回 ID、上级与名称（筛选与下拉用，不计算统计）/ list query: options returns ids, parents and names only (no statistics) */
export const territoryListSchema = z.strictObject({ view: z.enum(['full', 'options']).default('full') });

/**
 * 区域选项（筛选与下拉用）。
 * Territory options for filters and pickers.
 */
export async function listTerritoryOptions(ctx: AuthContext) {
  const items = await prisma.territory.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, parentId: true, name: true }, orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
  return { items };
}

/**
 * 区域列表（含负责人、成员、条件与统计；统计含下级区域）。
 * Territories with manager, members, conditions and statistics (descendants included).
 */
export async function listTerritories(ctx: AuthContext) {
  const org = ctx.organizationId;
  const owner = can(ctx, 'record.read.all') ? null : ctx.userId;
  const [rows, accounts, deals, rates] = await Promise.all([
    prisma.territory.findMany({ where: { organizationId: org }, select, orderBy: [{ priority: 'asc' }, { name: 'asc' }] }),
    prisma.account.groupBy({ by: ['territoryId'], where: { organizationId: org, ...(owner ? { ownerId: owner } : {}) }, _count: { _all: true } }),
    prisma.$queryRaw<StatRow[]>`
      SELECT a.territory_id, d.currency,
        count(*) FILTER (WHERE d.stage NOT IN ('CLOSED_WON', 'CLOSED_LOST'))::int AS open_count,
        sum(d.amount) FILTER (WHERE d.stage NOT IN ('CLOSED_WON', 'CLOSED_LOST')) AS open_amount,
        count(*) FILTER (WHERE d.stage = 'CLOSED_WON')::int AS won_count,
        sum(d.amount) FILTER (WHERE d.stage = 'CLOSED_WON') AS won_amount
      FROM deals d JOIN accounts a ON a.id = d.account_id AND a.organization_id = d.organization_id
      WHERE d.organization_id = ${org}::uuid AND (${owner}::uuid IS NULL OR d.owner_id = ${owner}::uuid)
      GROUP BY a.territory_id, d.currency`,
    ratesOn(org, new Date()),
  ]);
  const children = new Map<string | null, string[]>();
  for (const r of rows) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r.id]);
  const subtree = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(subtree)];
  const accountCount = (ids: (string | null)[]) => accounts.filter((a) => ids.includes(a.territoryId)).reduce((s, a) => s + a._count._all, 0);
  const dealStats = (ids: (string | null)[]) => {
    const rs = deals.filter((d) => ids.includes(d.territory_id));
    const sum = (key: 'open_amount' | 'won_amount') => {
      const m = new Map<string, Prisma.Decimal>();
      for (const r of rs) if (r.currency && r[key]) m.set(r.currency, (m.get(r.currency) ?? new Prisma.Decimal(0)).plus(r[key]!));
      return sumInBase(m, rates);
    };
    const open = sum('open_amount');
    const won = sum('won_amount');
    return {
      openCount: rs.reduce((s, r) => s + r.open_count, 0),
      openAmount: open.total,
      wonCount: rs.reduce((s, r) => s + r.won_count, 0),
      wonAmount: won.total,
      missingRates: [...new Set([...open.missing, ...won.missing])].sort(),
    };
  };
  const items = rows.map((r) => {
    const ids = subtree(r.id);
    return { ...shape(r), stats: { directAccounts: accountCount([r.id]), accounts: accountCount(ids), ...dealStats(ids) } };
  });
  const unassigned = { accounts: accountCount([null]), ...dealStats([null]) };
  return { items, unassigned, baseCurrency: BASE_CURRENCY };
}

/** 以 id 为根的子树高度（含自身；新建为 1）/ height of the subtree rooted at id (itself included; 1 when new) */
function heightOf(all: { id: string; parentId: string | null }[], id: string | null): number {
  if (!id) return 1;
  const kids = all.filter((t) => t.parentId === id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => heightOf(all, k.id))) : 0);
}
function treeError(code: 'cycle' | 'too_deep'): never {
  throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid territory tree', { parentId: [code] });
}
/** 树形检查：上级存在、无环、不超过 3 级 / tree check: the parent exists, no cycle, at most 3 levels */
function checkTree(all: { id: string; parentId: string | null }[], id: string | null, parentId: string | null) {
  if (!parentId) return;
  const byId = new Map(all.map((t) => [t.id, t]));
  if (!byId.has(parentId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown parent', { parentId: ['not_found'] });
  let depth = 1;
  for (let cur: string | null = parentId; cur; cur = byId.get(cur)?.parentId ?? null) {
    if (cur === id) treeError('cycle');
    depth += 1;
  }
  if (depth + heightOf(all, id) - 1 > MAX_DEPTH) treeError('too_deep');
}

/** 负责人与成员须为组织内的启用用户 / the manager and members must be active users of the organization */
async function checkUsers(tx: Prisma.TransactionClient, org: string, managerId: string | null | undefined, memberIds: string[] | undefined) {
  const ids = [...new Set([...(managerId ? [managerId] : []), ...(memberIds ?? [])])];
  if (!ids.length) return;
  const found = await tx.user.findMany({ where: { organizationId: org, id: { in: ids }, isActive: true }, select: { id: true } });
  const ok = new Set(found.map((u) => u.id));
  if (managerId && !ok.has(managerId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown manager', { managerId: ['not_found'] });
  if (memberIds?.some((m) => !ok.has(m))) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown member', { memberIds: ['not_found'] });
}

function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Territory name already exists', { name: ['taken'] });
  throw err;
}

/** 审计用的区域快照 / territory snapshot for audits */
const auditView = (t: ReturnType<typeof shape>) => ({
  name: t.name,
  parentId: t.parentId,
  managerId: t.managerId,
  priority: t.priority,
  match: t.match,
  conditions: t.conditions,
  memberIds: t.members.map((m) => m.id),
});

/**
 * 新建区域。
 * Create a territory.
 */
export async function createTerritory(ctx: AuthContext, input: z.infer<typeof territoryCreateSchema>) {
  requirePermission(ctx, 'territory.manage');
  const org = ctx.organizationId;
  const { memberIds, ...data } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${lockKey(org)}, 0))`;
      const all = await tx.territory.findMany({ where: { organizationId: org }, select: { id: true, parentId: true } });
      if (all.length >= MAX_TERRITORIES) throw new ApiError(409, 'CONFLICT', 'Too many territories', { name: ['limit_reached'] });
      checkTree(all, null, data.parentId);
      await checkUsers(tx, org, data.managerId, memberIds);
      const created = await tx.territory.create({ data: { ...data, conditions: data.conditions as Prisma.InputJsonValue, organizationId: org }, select: { id: true } });
      if (memberIds.length) await tx.territoryMember.createMany({ data: [...new Set(memberIds)].map((userId) => ({ organizationId: org, territoryId: created.id, userId })) });
      const t = shape(await tx.territory.findUniqueOrThrow({ where: { id: created.id }, select }));
      await audit(tx, { ...by(ctx), action: 'territory.create', entityType: 'territory', entityId: t.id, changes: { after: auditView(t) } });
      return t;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 修改区域（成员整体替换）。
 * Update a territory (members are replaced as a whole).
 */
export async function updateTerritory(ctx: AuthContext, id: string, input: z.infer<typeof territoryUpdateSchema>) {
  requirePermission(ctx, 'territory.manage');
  const org = ctx.organizationId;
  const { memberIds, ...data } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${lockKey(org)}, 0))`;
      const row = await tx.territory.findFirst({ where: { id, organizationId: org }, select });
      if (!row) throw notFound();
      const before = shape(row);
      if (data.parentId !== undefined && data.parentId !== before.parentId) {
        checkTree(await tx.territory.findMany({ where: { organizationId: org }, select: { id: true, parentId: true } }), id, data.parentId);
      }
      await checkUsers(tx, org, data.managerId, memberIds);
      await tx.territory.update({ where: { id }, data: { ...data, ...(data.conditions ? { conditions: data.conditions as Prisma.InputJsonValue } : {}) } });
      if (memberIds) {
        await tx.territoryMember.deleteMany({ where: { territoryId: id } });
        if (memberIds.length) await tx.territoryMember.createMany({ data: [...new Set(memberIds)].map((userId) => ({ organizationId: org, territoryId: id, userId })) });
      }
      const after = shape(await tx.territory.findUniqueOrThrow({ where: { id }, select }));
      const a = auditView(after);
      const b = auditView(before);
      const changed = Object.fromEntries((Object.keys(a) as (keyof typeof a)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => [k, [b[k], a[k]]]));
      if (Object.keys(changed).length) await audit(tx, { ...by(ctx), action: 'territory.update', entityType: 'territory', entityId: id, changes: { name: after.name, fields: changed } });
      return after;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除区域：有下级时 409；其中的客户变为无区域并恢复自动分配。
 * Delete a territory: 409 with children; its accounts become unassigned and automatic.
 */
export async function deleteTerritory(ctx: AuthContext, id: string): Promise<{ cleared: number }> {
  requirePermission(ctx, 'territory.manage');
  const org = ctx.organizationId;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${lockKey(org)}, 0))`;
    const t = await tx.territory.findFirst({ where: { id, organizationId: org }, select: { id: true, name: true } });
    if (!t) throw notFound();
    if (await tx.territory.count({ where: { organizationId: org, parentId: id } })) throw new ApiError(409, 'CONFLICT', 'Territory has children', { parentId: ['has_children'] });
    const { count } = await tx.account.updateMany({ where: { organizationId: org, territoryId: id }, data: { territoryId: null, territoryManual: false } });
    await tx.territory.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'territory.delete', entityType: 'territory', entityId: id, changes: { name: t.name, clearedAccounts: count } });
    return { cleared: count };
  });
}

/**
 * 重新分配：按规则重算全部非手工指定的客户（分批），只更新变化的客户。
 * Apply rules: recompute every account not set by hand (in batches), updating only those that change.
 */
export async function applyTerritoryRules(ctx: AuthContext): Promise<{ checked: number; changed: number }> {
  requirePermission(ctx, 'territory.manage');
  const org = ctx.organizationId;
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${lockKey(org)}, 0))`;
      const territories = await ruleTerritories(org, tx);
      let checked = 0;
      let changed = 0;
      for (let cursor: string | undefined; ; ) {
        const batch = await tx.account.findMany({
          where: { organizationId: org, territoryManual: false, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: { id: true, territoryId: true, name: true, industry: true, address: true, phone: true, website: true, ownerId: true },
          orderBy: { id: 'asc' },
          take: APPLY_BATCH,
        });
        if (!batch.length) break;
        cursor = batch[batch.length - 1]!.id;
        checked += batch.length;
        const moves = new Map<string | null, string[]>();
        for (const a of batch) {
          const target = matchTerritory(territories, a);
          if (target !== a.territoryId) moves.set(target, [...(moves.get(target) ?? []), a.id]);
        }
        for (const [territoryId, ids] of moves) {
          changed += (await tx.account.updateMany({ where: { organizationId: org, id: { in: ids }, territoryManual: false }, data: { territoryId } })).count;
        }
      }
      await audit(tx, { ...by(ctx), action: 'territory.apply', entityType: 'territory', entityId: null, changes: { checked, changed } });
      return { checked, changed };
    },
    { timeout: 60_000 },
  );
}
