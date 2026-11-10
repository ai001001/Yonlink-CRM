/**
 * 通用输入校验片段。
 * Reusable input validation fragments.
 */
import { z } from 'zod';
import { prisma } from './db';
import { ApiError } from './errors';

/**
 * 可选文本：去除首尾空白，空串转为 null。
 * Optional text: trimmed, empty string becomes null.
 * @param max 最大长度 / max length
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/**
 * 必填文本。
 * Required, trimmed text.
 */
export const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** 可选邮箱 / Optional email */
export const optionalEmail = z
  .union([z.literal(''), z.email().max(254)])
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null));

/** 可选 UUID（空串视为 null）/ Optional UUID (empty string → null) */
export const optionalUuid = z
  .union([z.literal(''), z.uuid()])
  .nullish()
  .transform((v) => (v ? v : null));

/** 分页与搜索参数 / Pagination and search query */
export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * 分页结果结构。
 * Paginated result shape.
 */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 确认负责人属于当前组织，未提供时使用当前用户。
 * Ensure the owner belongs to the current organization; defaults to the current user.
 * 客户端提交的 owner_id 不可信 / the client-supplied owner id is never trusted.
 * @param organizationId 当前组织 / current organization
 * @param ownerId 提交的负责人 / submitted owner
 * @param fallback 默认负责人 / default owner
 */
export async function resolveOwner(
  organizationId: string,
  ownerId: string | null | undefined,
  fallback: string | null,
): Promise<string | null> {
  if (ownerId === undefined) return fallback;
  if (ownerId === null) return null;
  const owner = await prisma.user.findFirst({ where: { id: ownerId, organizationId, isActive: true }, select: { id: true } });
  if (!owner) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid owner', { ownerId: ['Owner not found'] });
  return owner.id;
}

/**
 * 生成按字面匹配的不区分大小写模糊搜索条件（转义 LIKE 通配符 \ % _）。
 * Build a case-insensitive literal "contains" filter (escapes LIKE wildcards \ % _).
 * Prisma 的 contains 不会转义通配符 / Prisma's `contains` does not escape wildcards.
 * @param q 搜索词 / search term
 */
export function containsText(q: string) {
  return { contains: q.replace(/[\\%_]/g, (c) => `\\${c}`), mode: 'insensitive' as const };
}
