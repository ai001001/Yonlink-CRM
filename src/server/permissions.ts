/**
 * 角色权限（RBAC）与记录可见范围。所有判定在服务端完成，角色每个请求都从数据库读取。
 * Role-based permissions and record visibility. Decided server-side; the role is read from the DB per request.
 */
import type { UserRole } from '@/generated/prisma/enums';
import type { AuthContext } from './auth';
import { ApiError, notFound } from './errors';

/** 权限点 / Permissions */
export type Permission =
  | 'record.read.all' // 查看全部业务记录（否则只看自己负责的）/ read every record (otherwise own only)
  | 'record.create'
  | 'record.update.all' // 编辑全部记录（否则只能编辑自己负责的）/ edit every record (otherwise own only)
  | 'record.update.own'
  | 'record.delete'
  | 'owner.assign' // 把负责人设为他人 / assign records to others
  | 'audit.read'
  | 'product.manage' // 维护产品目录 / maintain the product catalog
  | 'tag.manage' // 标签改名、改色、删除 / rename, recolour and delete tags
  | 'recycle.purge' // 回收站彻底删除与清空 / permanently delete from the recycle bin
  | 'data.export' // 导出 CSV（批量带走客户数据，仅管理员与经理）/ CSV export (bulk data egress; admins and managers only)
  | 'user.manage';

/** 角色 → 权限 / Role → permissions */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  ADMIN: ['record.read.all', 'record.create', 'record.update.all', 'record.update.own', 'record.delete', 'owner.assign', 'audit.read', 'user.manage', 'data.export', 'product.manage', 'tag.manage', 'recycle.purge'],
  MANAGER: ['record.read.all', 'record.create', 'record.update.all', 'record.update.own', 'record.delete', 'owner.assign', 'data.export', 'product.manage', 'tag.manage'],
  SALES: ['record.create', 'record.update.own'],
  READONLY: ['record.read.all'],
};

/**
 * 是否拥有权限。
 * Whether the context has a permission.
 */
export function can(ctx: AuthContext, permission: Permission): boolean {
  return ROLE_PERMISSIONS[ctx.role].includes(permission);
}

/**
 * 要求权限，否则 403。
 * Require a permission or throw 403.
 */
export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!can(ctx, permission)) throw new ApiError(403, 'FORBIDDEN', 'Permission denied', { permission: [permission] });
}

/**
 * 可见范围条件：组织隔离 +（无全量查看权限时）只看自己负责的记录。用于线索/客户/商机/跟进。
 * Visibility filter: organization scope plus, without read-all, only records owned by the user.
 */
export function visible(ctx: AuthContext): { organizationId: string; ownerId?: string } {
  return can(ctx, 'record.read.all') ? { organizationId: ctx.organizationId } : { organizationId: ctx.organizationId, ownerId: ctx.userId };
}

/**
 * 确认可以编辑某条可见记录：需全量编辑权限，或是负责人且有编辑自己记录的权限。
 * Ensure a visible record may be edited: update-all, or owner with update-own.
 */
export function assertCanUpdate(ctx: AuthContext, record: { ownerId: string | null }): void {
  if (can(ctx, 'record.update.all')) return;
  if (can(ctx, 'record.update.own') && record.ownerId === ctx.userId) return;
  throw new ApiError(403, 'FORBIDDEN', 'Permission denied', { permission: ['record.update'] });
}

/**
 * 确认可以删除（删除权限 + 记录可见）。
 * Ensure the user may delete.
 */
export function assertCanDelete(ctx: AuthContext): void {
  requirePermission(ctx, 'record.delete');
}

/**
 * 负责人指派限制：无 owner.assign 时只能设为自己（不能取消分配或改给他人）。
 * Owner assignment: without owner.assign the owner can only be the user themself.
 * @param requested 请求的负责人（undefined 表示未修改）/ requested owner (undefined = unchanged)
 */
export function assertOwnerAssignable(ctx: AuthContext, requested: string | null | undefined): void {
  if (requested === undefined || can(ctx, 'owner.assign')) return;
  if (requested !== ctx.userId) throw new ApiError(403, 'FORBIDDEN', 'Cannot assign records to others', { ownerId: ['owner.assign required'] });
}

/** 不可见时统一 404（不泄露是否存在）/ invisible records are 404 (no existence leak) */
export { notFound };
