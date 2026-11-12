/**
 * 审计日志：在业务事务内写入，内容按字段策略脱敏。
 * Audit logging: written inside the business transaction, redacted per field policy.
 *
 * 脱敏策略 / Redaction policy
 * - mask：邮箱、电话类只保留首尾少量字符 / emails and phone numbers keep only a few characters
 * - redact：长文本（备注、跟进内容）只记录“已修改”，不记录原文 / long text is recorded as changed, never verbatim
 * - 未列出的字段（如密码哈希、会话令牌）一律不记录 / unlisted fields (password hashes, tokens) are never recorded
 */
import type { Prisma } from '@/generated/prisma/client';

/** 请求来源信息 / Request origin metadata */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** 审计对象类型 / Audited entity types */
export type AuditEntity = 'lead' | 'account' | 'contact' | 'deal' | 'activity' | 'note' | 'product' | 'quote' | 'user' | 'auth';

/** 字段策略 / Field policy */
type Policy = 'plain' | 'mask' | 'redact';

/** 各对象可审计字段及策略 / Auditable fields and their policy per entity */
export const AUDIT_FIELDS: Record<Exclude<AuditEntity, 'auth'>, Record<string, Policy>> = {
  lead: {
    name: 'plain', company: 'plain', title: 'plain', phone: 'mask', mobile: 'mask', email: 'mask',
    source: 'plain', status: 'plain', description: 'redact', ownerId: 'plain',
  },
  account: {
    name: 'plain', industry: 'plain', phone: 'mask', website: 'plain', address: 'redact', description: 'redact', ownerId: 'plain',
  },
  contact: { name: 'plain', title: 'plain', phone: 'mask', email: 'mask', isPrimary: 'plain', accountId: 'plain' },
  deal: {
    name: 'plain', accountId: 'plain', amount: 'plain', currency: 'plain', stage: 'plain',
    expectedCloseDate: 'plain', description: 'redact', ownerId: 'plain',
  },
  user: { name: 'plain', email: 'mask', role: 'plain', isActive: 'plain' },
  note: { content: 'redact', leadId: 'plain', accountId: 'plain', dealId: 'plain' },
  product: { sku: 'plain', name: 'plain', category: 'plain', unit: 'plain', unitPrice: 'plain', currency: 'plain', isActive: 'plain', description: 'redact' },
  quote: {
    quoteNumber: 'plain', subject: 'plain', status: 'plain', dealId: 'plain', currency: 'plain', validUntil: 'plain',
    taxPercent: 'plain', subtotal: 'plain', taxAmount: 'plain', total: 'plain', terms: 'redact', notes: 'redact',
  },
  activity: {
    type: 'plain', subject: 'plain', content: 'redact', dueAt: 'plain', completed: 'plain',
    accountId: 'plain', leadId: 'plain', dealId: 'plain', ownerId: 'plain',
  },
};

/** 长文本脱敏占位 / Placeholder for redacted long text */
export const REDACTED = '[redacted]';

/**
 * 打码字符串：邮箱保留首字符与域名，其他保留首 3 位与末 2 位。
 * Mask a string: emails keep the first char and domain; others keep the first 3 and last 2 chars.
 */
export function mask(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}***${value.slice(at)}`;
  if (value.length <= 5) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 5)}${value.slice(-2)}`;
}

/**
 * 把值规范化为可比较、可存储的 JSON 值（Decimal → 字符串，Date → ISO）。
 * Normalise a value to comparable JSON (Decimal → string, Date → ISO).
 */
function normalise(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'toFixed' in (value as object)) return String(value);
  return value;
}

/**
 * 按策略输出单个字段值。
 * Apply the field policy to a single value.
 */
function present(policy: Policy, value: unknown): unknown {
  const v = normalise(value);
  if (v === null) return null;
  if (policy === 'mask') return mask(String(v));
  if (policy === 'redact') return REDACTED;
  return v;
}

/**
 * 记录快照（新建/删除时使用），只包含可审计字段并已脱敏。
 * Snapshot of a record (create/delete), auditable fields only, redacted.
 */
export function snapshot(entity: Exclude<AuditEntity, 'auth'>, record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, policy] of Object.entries(AUDIT_FIELDS[entity])) {
    if (field in record) out[field] = present(policy, record[field]);
  }
  return out;
}

/**
 * 字段级差异（更新时使用）：{ 字段: [旧值, 新值] }，只含实际变化的可审计字段。
 * Field-level diff for updates: { field: [before, after] }, changed auditable fields only.
 */
export function diff(
  entity: Exclude<AuditEntity, 'auth'>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [field, policy] of Object.entries(AUDIT_FIELDS[entity])) {
    if (!(field in after)) continue;
    const b = normalise(before[field]);
    const a = normalise(after[field]);
    if (JSON.stringify(b) !== JSON.stringify(a)) out[field] = [present(policy, b), present(policy, a)];
  }
  return out;
}

/** 审计写入参数 / Audit entry */
export interface AuditEntry {
  organizationId: string;
  actorId: string | null;
  action: string;
  entityType: AuditEntity;
  entityId?: string | null;
  changes?: Record<string, unknown> | null;
  meta?: RequestMeta;
}

/**
 * 写入一条审计日志。必须传入业务事务客户端，保证与业务写入同成同败。
 * Write one audit entry. Pass the business transaction client so both commit or roll back together.
 */
export async function audit(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      changes: (entry.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: entry.meta?.ip?.slice(0, 64) ?? null,
      userAgent: entry.meta?.userAgent?.slice(0, 300) ?? null,
    },
  });
}

/**
 * 从请求提取来源信息（反向代理场景取 X-Forwarded-For 第一个地址）。
 * Extract request metadata (first X-Forwarded-For address behind a reverse proxy).
 */
export function requestMeta(req: Request): RequestMeta {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return {
    ip: forwarded || req.headers.get('x-real-ip') || null,
    userAgent: req.headers.get('user-agent'),
  };
}

/**
 * 由身份上下文生成审计的公共字段。
 * Common audit fields derived from the identity context.
 */
export function by(ctx: { organizationId: string; userId: string; meta?: RequestMeta }) {
  return { organizationId: ctx.organizationId, actorId: ctx.userId, meta: ctx.meta };
}
