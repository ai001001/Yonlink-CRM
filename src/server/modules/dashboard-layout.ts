/**
 * 个人工作台布局（对标 Zoho 首页自定义）：每个用户选择显示哪些卡片及其顺序，保存在服务端（换设备一致）。
 * - 只能使用已知卡片键，不能重复，至少保留一张卡片。
 * - 没有保存过或恢复默认时使用 DEFAULT_WIDGETS；读取时忽略已下线的未知键。
 * - 布局属于个人偏好，只影响本人的工作台显示，不写审计。
 * Personal dashboard layout (cf. Zoho home customisation): each user picks which cards to show and their order,
 * stored server-side (same on every device). Known keys only, no duplicates, at least one card. Without a saved
 * layout (or after a reset) DEFAULT_WIDGETS applies; unknown (retired) keys are ignored on read. A personal display
 * preference, so it is not audited.
 */
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { prisma } from '../db';

/** 全部卡片键（顺序即默认顺序）/ every card key (in default order) */
export const DASHBOARD_WIDGETS = ['counts', 'dealAmounts', 'myTodos', 'myTickets', 'recentActivities', 'closingSoon', 'stages'] as const;
/** 卡片键 / Card key */
export type DashboardWidget = (typeof DASHBOARD_WIDGETS)[number];
/** 默认布局：全部卡片 / default layout: every card */
export const DEFAULT_WIDGETS: DashboardWidget[] = [...DASHBOARD_WIDGETS];

/** 保存布局 / Save a layout */
export const layoutSchema = z.strictObject({
  widgets: z
    .array(z.enum(DASHBOARD_WIDGETS))
    .min(1)
    .max(DASHBOARD_WIDGETS.length)
    .refine((v) => new Set(v).size === v.length, 'Duplicate widgets'),
});

/** 布局结果 / Layout result */
export interface Layout {
  widgets: DashboardWidget[];
  /** 是否为默认布局（未保存过）/ whether this is the default (nothing saved) */
  isDefault: boolean;
}

/**
 * 读取当前用户的布局；未保存或保存的键全部失效时返回默认布局。
 * Read the current user's layout; the default when nothing is saved or no saved key is still valid.
 */
export async function getLayout(ctx: AuthContext): Promise<Layout> {
  const row = await prisma.userDashboardLayout.findFirst({ where: { organizationId: ctx.organizationId, userId: ctx.userId } });
  const saved = Array.isArray(row?.widgets) ? (row.widgets as unknown[]).filter((k): k is DashboardWidget => DASHBOARD_WIDGETS.includes(k as DashboardWidget)) : [];
  return saved.length ? { widgets: [...new Set(saved)], isDefault: false } : { widgets: DEFAULT_WIDGETS, isDefault: true };
}

/**
 * 保存当前用户的布局（存在则覆盖）。
 * Save the current user's layout (upsert).
 */
export async function saveLayout(ctx: AuthContext, input: z.infer<typeof layoutSchema>): Promise<Layout> {
  await prisma.userDashboardLayout.upsert({
    where: { userId: ctx.userId },
    create: { organizationId: ctx.organizationId, userId: ctx.userId, widgets: input.widgets },
    update: { widgets: input.widgets },
  });
  return { widgets: input.widgets, isDefault: false };
}

/**
 * 恢复默认布局（删除保存的布局）。
 * Reset to the default layout (delete the saved one).
 */
export async function resetLayout(ctx: AuthContext): Promise<Layout> {
  await prisma.userDashboardLayout.deleteMany({ where: { organizationId: ctx.organizationId, userId: ctx.userId } });
  return { widgets: DEFAULT_WIDGETS, isDefault: true };
}
