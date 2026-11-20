/**
 * API 密钥（对标 Zoho CRM API 访问）：管理员为本组织用户创建密钥，外部系统用 `Authorization: Bearer ylk_…` 以该用户的
 * 身份与当前权限调用接口（用户停用、密钥吊销或过期后立即失效）。
 * - 原文只在创建时返回一次，数据库只保存 SHA-256 哈希与前缀；审计只记录名称、前缀、绑定用户。
 * - 创建、吊销需 integration.manage（管理员）且必须是浏览器会话（不能用 API 密钥管理密钥）。
 * API keys (cf. Zoho CRM API access): admins create keys for organization users; external systems call the API with
 * `Authorization: Bearer ylk_…` as that user with the current permissions (deactivation, revocation or expiry take
 * effect at once). The key is returned once; only its SHA-256 hash and prefix are stored; audits record name, prefix
 * and user. Creating and revoking need integration.manage (admins) and a browser session.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { audit, by } from '../audit';
import { API_KEY_PREFIX, hashToken, requireSession, type AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission } from '../permissions';
import { requiredText } from '../validation';
import { dateOnly } from './deals';

/** 新建密钥 / create a key */
export const apiKeyCreateSchema = z.strictObject({
  name: requiredText(100),
  userId: z.uuid(),
  /** 到期日（含当天，UTC），为空不过期 / expiry date (inclusive, UTC); null never expires */
  expiresOn: dateOnly.nullish().transform((v) => (v ? new Date(`${v}T23:59:59.999Z`) : null)),
});

const select = {
  id: true,
  name: true,
  prefix: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdAt: true,
  user: { select: { id: true, name: true, role: true, isActive: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

/** 管理前置检查 / management guard */
function guard(ctx: AuthContext): void {
  requireSession(ctx);
  requirePermission(ctx, 'integration.manage');
}

/**
 * 密钥列表（不含原文与哈希）。
 * List keys (never the key or its hash).
 */
export async function listApiKeys(ctx: AuthContext) {
  guard(ctx);
  return { items: await prisma.apiKey.findMany({ where: { organizationId: ctx.organizationId }, select, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }) };
}

/**
 * 新建密钥：绑定用户须为本组织启用用户；到期日不能早于今天；返回原文（只此一次）。
 * Create a key bound to an active member; the expiry cannot be in the past; the key is returned once.
 */
export async function createApiKey(ctx: AuthContext, input: z.infer<typeof apiKeyCreateSchema>) {
  guard(ctx);
  const user = await prisma.user.findFirst({ where: { id: input.userId, organizationId: ctx.organizationId, isActive: true }, select: { id: true, name: true } });
  if (!user) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid user', { userId: ['not_found'] });
  if (input.expiresOn && input.expiresOn.getTime() < Date.now()) throw new ApiError(400, 'VALIDATION_ERROR', 'Expiry in the past', { expiresOn: ['past'] });
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const prefix = key.slice(0, 12);
  return prisma.$transaction(async (tx) => {
    const row = await tx.apiKey.create({
      data: { organizationId: ctx.organizationId, name: input.name, prefix, keyHash: hashToken(key), userId: user.id, createdById: ctx.userId, expiresAt: input.expiresOn },
      select,
    });
    await audit(tx, { ...by(ctx), action: 'apikey.create', entityType: 'apikey', entityId: row.id, changes: { name: row.name, prefix, userId: user.id, expiresAt: row.expiresAt } });
    return { ...row, key };
  });
}

/**
 * 吊销密钥（立即失效，不可恢复）。
 * Revoke a key (immediately and permanently).
 */
export async function revokeApiKey(ctx: AuthContext, id: string) {
  guard(ctx);
  return prisma.$transaction(async (tx) => {
    const current = await tx.apiKey.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true, name: true, prefix: true, revokedAt: true } });
    if (!current) throw notFound();
    if (current.revokedAt) throw new ApiError(409, 'CONFLICT', 'Already revoked', { revokedAt: ['already'] });
    const row = await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() }, select });
    await audit(tx, { ...by(ctx), action: 'apikey.revoke', entityType: 'apikey', entityId: id, changes: { name: current.name, prefix: current.prefix } });
    return row;
  });
}
