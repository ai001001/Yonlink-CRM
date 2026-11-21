/**
 * 区域规则与筛选（客户、商机、导入、线索转化使用）：按规则匹配区域、客户写入时的区域、列表筛选对应的区域 ID。
 * 不依赖客户与商机模块，避免循环引用；区域的维护与统计在 territories.ts。
 * Territory rules and filters (used by accounts, deals, imports and lead conversion): rule matching, the territory for
 * account writes and the territory ids behind list filters. Independent of the account and deal modules to avoid
 * import cycles; maintenance and statistics live in territories.ts.
 */
import type { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { TerritoryMatch } from '@/generated/prisma/enums';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { INDUSTRIES } from './dictionaries';
import type { territoryFilter, territoryInput } from './territory-input';
import { evaluate, type Condition, type FieldDef } from './workflows';

/** 规则可用的客户字段 / account fields usable in rules */
export const TERRITORY_FIELDS: Record<string, FieldDef> = {
  name: { type: 'text' },
  industry: { type: 'enum', values: INDUSTRIES },
  address: { type: 'text' },
  phone: { type: 'text' },
  website: { type: 'text' },
  ownerId: { type: 'id' },
};

/** 规则匹配用的区域 / territory as used by rule matching */
export interface RuleTerritory {
  id: string;
  name: string;
  priority: number;
  match: TerritoryMatch;
  conditions: unknown;
}

/**
 * 按规则为客户选区域（优先级小的先，同优先级按名称；没有条件的区域不参与）。
 * Pick a territory for an account by rules (lower priority first, ties by name; territories without conditions skip).
 */
export function matchTerritory(territories: RuleTerritory[], account: Record<string, unknown>): string | null {
  const sorted = [...territories].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
  for (const t of sorted) {
    const conditions = Array.isArray(t.conditions) ? (t.conditions as Condition[]) : [];
    if (!conditions.length) continue;
    const hit = (c: Condition) => evaluate(TERRITORY_FIELDS[c.field], c, account[c.field]);
    if (t.match === TerritoryMatch.ANY ? conditions.some(hit) : conditions.every(hit)) return t.id;
  }
  return null;
}

/** 组织的规则区域 / rule territories of an organization */
export const ruleTerritories = (org: string, client: Prisma.TransactionClient = prisma) =>
  client.territory.findMany({ where: { organizationId: org }, select: { id: true, name: true, priority: true, match: true, conditions: true } });

/**
 * 按规则分配区域的函数（导入、线索转化等批量或系统写入使用；区域只读取一次）。
 * A rule-based territory matcher for imports, lead conversion and other system writes (territories are read once).
 */
export async function territoryMatcher(org: string, client: Prisma.TransactionClient = prisma) {
  const territories = await ruleTerritories(org, client);
  return (account: Record<string, unknown>) => ({ territoryId: matchTerritory(territories, account), territoryManual: false });
}

/**
 * 客户写入时的区域：指定 ID/null 为手工（需 territory.manage），AUTO 或未手工指定时按规则计算。
 * Territory for an account write: an id or null is manual (needs territory.manage); AUTO, or not manual, uses rules.
 * @param record 写入后的客户字段 / account fields after the write
 * @param current 当前是否手工指定（新建为 null）/ whether the current territory is manual (null on create)
 * @returns 要写入的字段；undefined 表示不变 / fields to write; undefined leaves them unchanged
 */
export async function resolveTerritory(
  ctx: AuthContext,
  input: z.infer<typeof territoryInput>,
  record: Record<string, unknown>,
  current: { territoryManual: boolean } | null,
): Promise<{ territoryId: string | null; territoryManual: boolean } | undefined> {
  if (input !== undefined) {
    if (!can(ctx, 'territory.manage')) throw new ApiError(403, 'FORBIDDEN', 'Cannot set territories', { territoryId: ['territory.manage required'] });
    if (input === null) return { territoryId: null, territoryManual: true };
    if (input !== 'AUTO') {
      const exists = await prisma.territory.count({ where: { id: input, organizationId: ctx.organizationId } });
      if (!exists) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown territory', { territoryId: ['not_found'] });
      return { territoryId: input, territoryManual: true };
    }
  } else if (current?.territoryManual) {
    return undefined;
  }
  return { territoryId: matchTerritory(await ruleTerritories(ctx.organizationId), record), territoryManual: false };
}

/**
 * 区域及其全部下级的 ID（只含本组织的区域）。
 * Ids of territories and all their descendants (this organization's only).
 */
async function withDescendants(org: string, roots: string[]): Promise<string[]> {
  if (!roots.length) return [];
  const all = await prisma.territory.findMany({ where: { organizationId: org }, select: { id: true, parentId: true } });
  const ids = new Set(roots.filter((r) => all.some((t) => t.id === r)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of all) {
      if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return [...ids];
}

/**
 * 列表筛选对应的区域 ID：undefined 不筛选，null 为无区域；其他组织的区域得到空数组。
 * Territory ids for a list filter: undefined means no filter, null means none; other organizations' ids give [].
 */
export async function territoryIdsFor(ctx: AuthContext, filter: z.infer<typeof territoryFilter>): Promise<string[] | null | undefined> {
  if (filter === undefined) return undefined;
  if (filter === 'NONE') return null;
  if (filter === 'MINE') {
    const mine = await prisma.territory.findMany({
      where: { organizationId: ctx.organizationId, OR: [{ managerId: ctx.userId }, { members: { some: { userId: ctx.userId } } }] },
      select: { id: true },
    });
    return withDescendants(ctx.organizationId, mine.map((t) => t.id));
  }
  return withDescendants(ctx.organizationId, [filter]);
}
