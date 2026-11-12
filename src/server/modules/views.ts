/**
 * 保存的视图（参考 Zoho Custom Views）：线索、客户、商机、跟进列表的筛选条件可保存为视图并一键切换。
 * - 筛选条件按列表白名单校验（与列表查询参数一致）；视图只保存条件，数据仍按查看者权限过滤。
 * - 私有视图所有登录用户均可创建；共享给全组织需 view.share（管理员、经理）；只有创建者能修改，
 *   共享视图也可由 view.share 持有者删除；每人每个列表最多 50 个；同一人同一列表名称唯一。
 * - 默认视图按用户保存，只能设为自己可见的同列表视图；取消共享时移除他人对该视图的默认设置。
 * - 共享视图的新建、修改、删除写审计。
 * Saved views (cf. Zoho Custom Views) for the lead, account, deal and activity lists: whitelisted filters only;
 * records stay filtered by the viewer's permissions; private views for everyone, sharing needs view.share;
 * only the creator edits; ≤ 50 per user and list; per-user defaults; shared-view changes are audited.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { audit, by, diff, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { can, requirePermission } from '../permissions';
import { accountListSchema } from './accounts';
import { activityListSchema } from './activities';
import { dealListSchema } from './deals';
import { leadListSchema } from './leads';

/** 视图所属列表 / view lists */
export const VIEW_ENTITIES = ['leads', 'accounts', 'deals', 'activities'] as const;
export type ViewEntity = (typeof VIEW_ENTITIES)[number];
/** 每人每个列表最多视图数 / max views per user and list */
export const MAX_VIEWS = 50;

/** 各列表可保存的筛选条件（与列表查询参数一致）/ savable filters per list (same as the list query) */
export const FILTER_SCHEMAS: Record<ViewEntity, z.ZodType<Record<string, string | undefined>>> = {
  leads: z.strictObject(leadListSchema.pick({ q: true, status: true, source: true, tagId: true, ownerId: true }).shape),
  accounts: z.strictObject(accountListSchema.pick({ q: true, industry: true, tagId: true, ownerId: true }).shape),
  deals: z.strictObject(dealListSchema.pick({ q: true, stage: true, tagId: true, ownerId: true }).shape),
  activities: z.strictObject(activityListSchema.pick({ q: true, type: true, completed: true, ownerId: true }).shape),
};

const name = z.string().trim().min(1).max(50);
const entity = z.enum(VIEW_ENTITIES);

/** 新建视图 / Create view */
export const viewCreateSchema = z.strictObject({ entity, name, filters: z.record(z.string(), z.unknown()), shared: z.boolean().default(false) });
/** 修改视图 / Update view */
export const viewUpdateSchema = z.strictObject({ name, filters: z.record(z.string(), z.unknown()), shared: z.boolean() }).partial();
/** 列表查询 / List query */
export const viewListSchema = z.strictObject({ entity });
/** 设置默认视图（null 表示取消）/ Set the default view (null clears it) */
export const viewDefaultSchema = z.strictObject({ entity, viewId: z.uuid().nullable() });

/**
 * 按列表白名单校验并规范化筛选条件（去掉空值）。
 * Validate filters against the list whitelist and drop empty values.
 */
export function parseFilters(list: ViewEntity, filters: Record<string, unknown>): Record<string, string> {
  const r = FILTER_SCHEMAS[list].safeParse(filters);
  if (!r.success) {
    const details: Record<string, string[]> = {};
    for (const issue of r.error.issues) {
      const key = ['filters', ...issue.path.map(String)].join('.');
      (details[key] ??= []).push(issue.message);
    }
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid filters', details);
  }
  return Object.fromEntries(Object.entries(r.data).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

const select = {
  id: true,
  entity: true,
  name: true,
  filters: true,
  shared: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true } },
} satisfies Prisma.SavedViewSelect;

/** 当前用户可见的视图条件 / views visible to the user */
const visibleViews = (ctx: AuthContext): Prisma.SavedViewWhereInput => ({ organizationId: ctx.organizationId, OR: [{ ownerId: ctx.userId }, { shared: true }] });

/**
 * 列表的视图：自己的与共享的，以及我的默认视图。
 * Views of a list (mine and shared) and my default view.
 */
export async function listViews(ctx: AuthContext, query: z.infer<typeof viewListSchema>) {
  const [items, def] = await Promise.all([
    prisma.savedView.findMany({ where: { ...visibleViews(ctx), entity: query.entity }, select, orderBy: [{ shared: 'asc' }, { name: 'asc' }] }),
    prisma.userViewDefault.findUnique({ where: { userId_entity: { userId: ctx.userId, entity: query.entity } }, select: { viewId: true } }),
  ]);
  return { items, defaultViewId: def && items.some((v) => v.id === def.viewId) ? def.viewId : null };
}

/** 名称重复 / duplicate name */
const nameTaken = () => new ApiError(409, 'CONFLICT', 'View name already exists', { name: ['taken'] });

/**
 * 新建视图（共享需 view.share；名称重复 409；超过上限 400）。
 * Create a view (sharing needs view.share; duplicate → 409; over the limit → 400).
 */
export async function createView(ctx: AuthContext, input: z.infer<typeof viewCreateSchema>) {
  if (input.shared) requirePermission(ctx, 'view.share');
  const filters = parseFilters(input.entity, input.filters);
  const where = { organizationId: ctx.organizationId, ownerId: ctx.userId, entity: input.entity };
  if ((await prisma.savedView.count({ where })) >= MAX_VIEWS) throw new ApiError(400, 'VALIDATION_ERROR', 'Too many views', { name: ['limit'] });
  if (await prisma.savedView.count({ where: { ...where, name: input.name } })) throw nameTaken();
  return prisma.$transaction(async (tx) => {
    const view = await tx.savedView.create({ data: { ...where, name: input.name, filters, shared: input.shared }, select });
    if (view.shared) await audit(tx, { ...by(ctx), action: 'view.create', entityType: 'view', entityId: view.id, changes: { after: snapshot('view', view) } });
    return view;
  });
}

/**
 * 读取可见视图。
 * Load a visible view.
 */
async function requireView(ctx: AuthContext, id: string) {
  const view = await prisma.savedView.findFirst({ where: { id, ...visibleViews(ctx) }, select });
  if (!view) throw notFound();
  return view;
}

/**
 * 修改视图（仅创建者；共享需 view.share；取消共享时移除他人的默认设置）。
 * Update a view (creator only; sharing needs view.share; unsharing removes other users' defaults).
 */
export async function updateView(ctx: AuthContext, id: string, input: z.infer<typeof viewUpdateSchema>) {
  const current = await requireView(ctx, id);
  if (current.ownerId !== ctx.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the creator can change a view');
  if (input.shared) requirePermission(ctx, 'view.share');
  const data: Prisma.SavedViewUpdateInput = { name: input.name, shared: input.shared };
  if (input.filters) data.filters = parseFilters(current.entity, input.filters);
  if (input.name !== undefined && input.name !== current.name) {
    if (await prisma.savedView.count({ where: { organizationId: ctx.organizationId, ownerId: ctx.userId, entity: current.entity, name: input.name } })) throw nameTaken();
  }
  return prisma.$transaction(async (tx) => {
    const view = await tx.savedView.update({ where: { id }, data, select });
    if (current.shared && !view.shared) await tx.userViewDefault.deleteMany({ where: { viewId: id, userId: { not: ctx.userId } } });
    if (current.shared || view.shared) {
      const fields = diff('view', current, view);
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'view.update', entityType: 'view', entityId: id, changes: { fields } });
    }
    return view;
  });
}

/**
 * 删除视图（创建者；共享视图也可由 view.share 持有者删除）；相关默认设置随之删除。
 * Delete a view (creator; shared views also by view.share holders); defaults cascade.
 */
export async function deleteView(ctx: AuthContext, id: string): Promise<void> {
  const current = await requireView(ctx, id);
  if (current.ownerId !== ctx.userId && !(current.shared && can(ctx, 'view.share'))) throw new ApiError(403, 'FORBIDDEN', 'Cannot delete this view');
  await prisma.$transaction(async (tx) => {
    await tx.savedView.delete({ where: { id } });
    if (current.shared) await audit(tx, { ...by(ctx), action: 'view.delete', entityType: 'view', entityId: id, changes: { before: snapshot('view', current) } });
  });
}

/**
 * 设置或取消我的默认视图（视图须可见且属于同一列表）。
 * Set or clear my default view (the view must be visible and belong to the same list).
 */
export async function setDefaultView(ctx: AuthContext, input: z.infer<typeof viewDefaultSchema>) {
  const key = { userId_entity: { userId: ctx.userId, entity: input.entity } };
  if (input.viewId === null) {
    await prisma.userViewDefault.deleteMany({ where: { userId: ctx.userId, entity: input.entity } });
    return { defaultViewId: null };
  }
  const view = await requireView(ctx, input.viewId);
  if (view.entity !== input.entity) throw new ApiError(400, 'VALIDATION_ERROR', 'View belongs to another list', { viewId: ['entity_mismatch'] });
  await prisma.userViewDefault.upsert({
    where: key,
    create: { organizationId: ctx.organizationId, userId: ctx.userId, entity: input.entity, viewId: view.id },
    update: { viewId: view.id },
  });
  return { defaultViewId: view.id };
}
