/**
 * Webhook（对标 Zoho Webhooks）：工作流动作把事件写入投递队列（与触发写入同一事务），再异步发送到外部地址。
 * - 安全：只允许 https（测试环境可用 WEBHOOK_ALLOW_HTTP=1 放开 http）；地址不能带账号密码；连接时校验解析出的 IP，
 *   拒绝回环、内网、链路本地等地址（防 SSRF；测试环境可用 WEBHOOK_ALLOW_PRIVATE=1 放开）；不跟随重定向；10 秒超时。
 * - 签名与防重放：请求头 X-Yonlink-Timestamp（秒）与 X-Yonlink-Signature: v1=HMAC-SHA256(密钥, "时间戳.请求体")；
 *   X-Yonlink-Delivery 为投递 ID，重试时不变，接收方据此幂等处理。签名密钥只在创建与重新生成时显示。
 * - 重试：2xx 为成功；否则按 1、5、30、120、360 分钟退避，第 6 次仍失败标记为失败，可手动重试。
 *   投递由定时任务每分钟处理（scripts/webhook-sweep.ts），产生投递后也会尽快在后台发送；多个进程并发处理不会重复领取。
 * - 负载只含记录 ID、名称与业务状态字段，不含邮箱、电话等个人信息。
 * - 维护需 integration.manage（管理员）且必须是浏览器会话；所有维护操作写审计（不记录密钥）。
 * Webhooks (cf. Zoho Webhooks): workflow actions queue events in the triggering transaction; delivery is asynchronous.
 * https only (http with WEBHOOK_ALLOW_HTTP=1 in tests); no credentials in URLs; resolved IPs are checked on connect and
 * loopback/private/link-local addresses are refused (SSRF; WEBHOOK_ALLOW_PRIVATE=1 in tests); no redirects; 10 s
 * timeout. Signed with X-Yonlink-Signature: v1=HMAC-SHA256(secret, "timestamp.body") plus X-Yonlink-Timestamp; the
 * stable X-Yonlink-Delivery id lets receivers dedupe. 2xx succeeds; otherwise retries back off 1, 5, 30, 120, 360 minutes
 * and the 6th failure is final (manual retry possible). A one-minute timer job delivers the queue, and new deliveries
 * are also sent soon in the background; concurrent workers never claim the same delivery. Payloads carry ids, names and
 * business status fields only, no emails or phone numbers. Maintenance needs integration.manage and a browser session;
 * every change is audited without secrets.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { WebhookDeliveryStatus } from '@/generated/prisma/enums';
import { audit, by } from '../audit';
import { requireSession, type AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { can, requirePermission } from '../permissions';
import { requiredText } from '../validation';

/** 重试间隔（分钟）；第 6 次失败为最终失败 / retry delays (minutes); the 6th failure is final */
export const RETRY_MINUTES = [1, 5, 30, 120, 360] as const;
/** 单次请求超时 / request timeout */
const TIMEOUT_MS = 10_000;

const allowHttp = () => process.env.WEBHOOK_ALLOW_HTTP === '1';
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === '1';

/**
 * 是否为不允许访问的地址（回环、内网、链路本地、组播、保留）。
 * Whether an address is off-limits (loopback, private, link-local, multicast, reserved).
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(v) === 6) {
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
  }
  return true;
}

/** Webhook 地址校验 / webhook URL validation */
const urlSchema = z
  .string()
  .trim()
  .max(500)
  .superRefine((v, ctx) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid_url' });
      return;
    }
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && allowHttp()))) ctx.addIssue({ code: 'custom', message: 'https_required' });
    if (u.username || u.password) ctx.addIssue({ code: 'custom', message: 'no_credentials' });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate() && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host)))) ctx.addIssue({ code: 'custom', message: 'private_address' });
  });

/** 新建 / create */
export const webhookCreateSchema = z.strictObject({ name: requiredText(100), url: urlSchema, isActive: z.boolean().default(true) });
/** 修改 / update */
export const webhookUpdateSchema = z.strictObject({ name: requiredText(100), url: urlSchema, isActive: z.boolean() }).partial();
/** 投递列表 / delivery list */
export const deliveryListSchema = z.strictObject({
  status: z.enum(WebhookDeliveryStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const select = {
  id: true,
  name: true,
  url: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WebhookSelect;

/** 新签名密钥 / a new signing secret */
const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** 管理前置检查 / management guard */
function guard(ctx: AuthContext): void {
  requireSession(ctx);
  requirePermission(ctx, 'integration.manage');
}

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Webhook name already exists', { name: ['taken'] });
  throw err;
}

/**
 * Webhook 列表（附各状态投递数，不含密钥）；工作流选择动作时也会读取，因此有 workflow.manage 也可查看。
 * List webhooks with delivery counts (no secrets); readable with workflow.manage too, for choosing workflow actions.
 */
export async function listWebhooks(ctx: AuthContext) {
  if (!can(ctx, 'integration.manage') && !can(ctx, 'workflow.manage')) requirePermission(ctx, 'integration.manage');
  const rows = await prisma.webhook.findMany({ where: { organizationId: ctx.organizationId }, select, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  const counts = await prisma.webhookDelivery.groupBy({ by: ['webhookId', 'status'], where: { organizationId: ctx.organizationId }, _count: { _all: true }, orderBy: { webhookId: 'asc' } });
  return {
    items: rows.map((w) => ({
      ...w,
      deliveries: Object.fromEntries(Object.values(WebhookDeliveryStatus).map((s) => [s, counts.find((c) => c.webhookId === w.id && c.status === s)?._count._all ?? 0])),
    })),
  };
}

/**
 * 新建 Webhook，返回签名密钥（只此一次）。
 * Create a webhook; the signing secret is returned once.
 */
export async function createWebhook(ctx: AuthContext, input: z.infer<typeof webhookCreateSchema>) {
  guard(ctx);
  const secret = newSecret();
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.webhook.create({ data: { ...input, secret, organizationId: ctx.organizationId, createdById: ctx.userId }, select });
      await audit(tx, { ...by(ctx), action: 'webhook.create', entityType: 'webhook', entityId: row.id, changes: { name: row.name, url: row.url, isActive: row.isActive } });
      return { ...row, secret };
    });
  } catch (err) {
    nameTaken(err);
  }
}

/** 读取本组织的 Webhook / load an organization webhook */
async function requireWebhook(ctx: AuthContext, id: string) {
  const row = await prisma.webhook.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!row) throw notFound();
  return row;
}

/**
 * 修改名称、地址、启停（停用后新的工作流动作不再入队，已入队的投递标记失败）。
 * Update name, URL or status (inactive webhooks queue nothing new; queued deliveries fail).
 */
export async function updateWebhook(ctx: AuthContext, id: string, input: z.infer<typeof webhookUpdateSchema>) {
  guard(ctx);
  const current = await requireWebhook(ctx, id);
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.webhook.update({ where: { id }, data: input, select });
      const fields = Object.fromEntries(
        (['name', 'url', 'isActive'] as const).filter((k) => current[k] !== row[k]).map((k) => [k, [current[k], row[k]]]),
      );
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'webhook.update', entityType: 'webhook', entityId: id, changes: { fields } });
      return row;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 重新生成签名密钥（旧密钥立即失效），返回新密钥。
 * Regenerate the signing secret (the old one stops working at once); returns the new secret.
 */
export async function regenerateSecret(ctx: AuthContext, id: string) {
  guard(ctx);
  await requireWebhook(ctx, id);
  const secret = newSecret();
  await prisma.$transaction(async (tx) => {
    await tx.webhook.update({ where: { id }, data: { secret } });
    await audit(tx, { ...by(ctx), action: 'webhook.regenerate_secret', entityType: 'webhook', entityId: id });
  });
  return { secret };
}

/**
 * 删除 Webhook（投递记录一并删除；引用它的工作流动作执行时跳过）。
 * Delete a webhook (deliveries go with it; workflow actions referencing it are skipped).
 */
export async function deleteWebhook(ctx: AuthContext, id: string): Promise<void> {
  guard(ctx);
  const current = await requireWebhook(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.webhook.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'webhook.delete', entityType: 'webhook', entityId: id, changes: { name: current.name, url: current.url } });
  });
}

/**
 * 写入投递队列（在业务事务内调用；Webhook 不存在或已停用时返回 false）。
 * Queue a delivery inside the business transaction; false when the webhook is missing or inactive.
 */
export async function enqueueDelivery(tx: Prisma.TransactionClient, organizationId: string, webhookId: string, event: string, data: Record<string, unknown>): Promise<boolean> {
  const hook = await tx.webhook.findFirst({ where: { id: webhookId, organizationId, isActive: true }, select: { id: true } });
  if (!hook) return false;
  const id = crypto.randomUUID();
  await tx.webhookDelivery.create({ data: { id, organizationId, webhookId, event, payload: { id, event, occurredAt: new Date().toISOString(), data } as Prisma.InputJsonValue } });
  scheduleDispatch();
  return true;
}

let pending: ReturnType<typeof setTimeout> | null = null;
/**
 * 产生投递后约 2 秒在后台发送（等待业务事务提交；测试中不自动发送）。没赶上的由定时任务补发。
 * Send in the background about 2 s after queuing (after the commit; not in tests); the timer job catches the rest.
 */
function scheduleDispatch(): void {
  if (process.env.VITEST || process.env.WEBHOOK_AUTO_DISPATCH === '0' || pending) return;
  pending = setTimeout(() => {
    pending = null;
    deliverDue().catch((err: Error) => console.error(`webhook dispatch failed: ${err.message}`));
  }, 2000);
  pending.unref?.();
}

/**
 * 签名：HMAC-SHA256(密钥, "时间戳.请求体") 的十六进制。
 * Signature: hex HMAC-SHA256(secret, "timestamp.body").
 */
export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** 发送结果 / send result */
interface SendResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

/**
 * 发送一次请求（连接时校验 IP；不跟随重定向；超时 10 秒）。
 * Send one request (IP checked on connect; no redirects; 10 s timeout).
 */
export function send(url: string, headers: Record<string, string>, body: string): Promise<SendResult> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, statusCode: null, error: 'invalid_url' });
      return;
    }
    // IP 字面量不经过 DNS 解析（自定义 lookup 不会被调用），必须单独检查 / IP literals skip DNS, so the custom lookup never runs
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !allowPrivate() && isPrivateAddress(literal)) {
      resolve({ ok: false, statusCode: null, error: 'private_address' });
      return;
    }
    const lookup = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, '');
        const list = addresses as LookupAddress[];
        if (!allowPrivate() && list.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error('private_address'), { code: 'EPRIVATE' }), '');
        cb(null, list);
      });
    };
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, lookup, timeout: TIMEOUT_MS }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      resolve({ ok: code >= 200 && code < 300, statusCode: code, error: code >= 200 && code < 300 ? null : `http_${code}` });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, statusCode: null, error: (err.message || 'error').slice(0, 200) }));
    req.end(body);
  });
}

/**
 * 发送一条已领取的投递并记录结果。
 * Send one claimed delivery and record the outcome.
 */
async function deliverOne(id: string, now: () => Date): Promise<'succeeded' | 'retry' | 'failed'> {
  const d = await prisma.webhookDelivery.findUnique({ where: { id }, include: { webhook: true } });
  if (!d || d.status !== WebhookDeliveryStatus.PENDING) return 'failed';
  const attempts = d.attempts + 1;
  if (!d.webhook.isActive) {
    await prisma.webhookDelivery.update({ where: { id }, data: { status: WebhookDeliveryStatus.FAILED, attempts, lastError: 'webhook_inactive', lastStatusCode: null } });
    return 'failed';
  }
  const body = JSON.stringify(d.payload);
  const ts = Math.floor(now().getTime() / 1000);
  const r = await send(d.webhook.url, {
    'content-type': 'application/json',
    'user-agent': 'Yonlink-CRM-Webhook/1.0',
    'x-yonlink-event': d.event,
    'x-yonlink-delivery': d.id,
    'x-yonlink-timestamp': String(ts),
    'x-yonlink-signature': `v1=${sign(d.webhook.secret, ts, body)}`,
  }, body);
  if (r.ok) {
    await prisma.webhookDelivery.update({ where: { id }, data: { status: WebhookDeliveryStatus.SUCCEEDED, attempts, lastStatusCode: r.statusCode, lastError: null, deliveredAt: now() } });
    return 'succeeded';
  }
  const delay = RETRY_MINUTES[attempts - 1];
  await prisma.webhookDelivery.update({
    where: { id },
    data: delay === undefined
      ? { status: WebhookDeliveryStatus.FAILED, attempts, lastStatusCode: r.statusCode, lastError: r.error }
      : { attempts, lastStatusCode: r.statusCode, lastError: r.error, nextAttemptAt: new Date(now().getTime() + delay * 60_000) },
  });
  return delay === undefined ? 'failed' : 'retry';
}

/**
 * 处理到期的投递：先在短事务里领取（SKIP LOCKED，并把下次时间推后 5 分钟作为租约），再逐条发送。
 * Deliver due items: claim them in a short transaction (SKIP LOCKED, pushing the next time 5 minutes out as a lease),
 * then send one by one.
 */
export async function deliverDue(opts: { organizationId?: string; limit?: number; ids?: string[]; now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const at = now();
  const lease = new Date(at.getTime() + 5 * 60_000);
  const org = opts.organizationId ? Prisma.sql`AND organization_id = ${opts.organizationId}::uuid` : Prisma.empty;
  const only = opts.ids?.length ? Prisma.sql`AND id = ANY(${opts.ids}::uuid[])` : Prisma.empty;
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE webhook_deliveries SET next_attempt_at = ${lease}
    WHERE id IN (
      SELECT id FROM webhook_deliveries
      WHERE status = 'PENDING' AND next_attempt_at <= ${at} ${org} ${only}
      ORDER BY next_attempt_at, id LIMIT ${opts.limit ?? 50}
      FOR UPDATE SKIP LOCKED
    ) RETURNING id`;
  const result = { claimed: claimed.length, succeeded: 0, retry: 0, failed: 0 };
  for (const c of claimed) result[await deliverOne(c.id, now)] += 1;
  return result;
}

/**
 * 发送测试事件（ping）并立即返回结果；停用的 Webhook 也可测试。
 * Send a test (ping) event and return the result at once; inactive webhooks can be tested too.
 */
export async function testWebhook(ctx: AuthContext, id: string) {
  guard(ctx);
  const hook = await requireWebhook(ctx, id);
  const deliveryId = crypto.randomUUID();
  const payload = { id: deliveryId, event: 'ping', occurredAt: new Date().toISOString(), data: { webhook: hook.name } };
  await prisma.webhookDelivery.create({ data: { id: deliveryId, organizationId: ctx.organizationId, webhookId: id, event: 'ping', payload } });
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const r = await send(hook.url, {
    'content-type': 'application/json',
    'user-agent': 'Yonlink-CRM-Webhook/1.0',
    'x-yonlink-event': 'ping',
    'x-yonlink-delivery': deliveryId,
    'x-yonlink-timestamp': String(ts),
    'x-yonlink-signature': `v1=${sign(hook.secret, ts, body)}`,
  }, body);
  // 测试投递不重试 / test deliveries are not retried
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: r.ok ? WebhookDeliveryStatus.SUCCEEDED : WebhookDeliveryStatus.FAILED, attempts: 1, lastStatusCode: r.statusCode, lastError: r.error, deliveredAt: r.ok ? new Date() : null },
  });
  await audit(prisma, { ...by(ctx), action: 'webhook.test', entityType: 'webhook', entityId: id, changes: { ok: r.ok, statusCode: r.statusCode } });
  return { ok: r.ok, statusCode: r.statusCode, error: r.error, deliveryId };
}

/**
 * 投递记录（最新在前，含负载）。
 * Deliveries of a webhook, newest first, with payloads.
 */
export async function listDeliveries(ctx: AuthContext, webhookId: string, query: z.infer<typeof deliveryListSchema>) {
  guard(ctx);
  await requireWebhook(ctx, webhookId);
  const where = { organizationId: ctx.organizationId, webhookId, status: query.status };
  const [items, total] = await prisma.$transaction([
    prisma.webhookDelivery.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.webhookDelivery.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 手动重试失败的投递（重置次数，立即到期，并在后台尽快发送）。
 * Retry a failed delivery manually (attempts reset, due now, sent soon in the background).
 */
export async function retryDelivery(ctx: AuthContext, id: string) {
  guard(ctx);
  const delivery = await prisma.webhookDelivery.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { webhookId: true } });
  if (!delivery) throw notFound();
  const n = await prisma.webhookDelivery.updateMany({
    where: { id, organizationId: ctx.organizationId, status: WebhookDeliveryStatus.FAILED, event: { not: 'ping' } },
    data: { status: WebhookDeliveryStatus.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  if (n.count !== 1) throw new ApiError(409, 'CONFLICT', 'Only failed deliveries can be retried', { status: ['not_failed'] });
  await audit(prisma, { ...by(ctx), action: 'webhook.retry', entityType: 'webhook', entityId: delivery.webhookId, changes: { deliveryId: id } });
  scheduleDispatch();
  return { status: WebhookDeliveryStatus.PENDING };
}

/**
 * 处理全部组织的到期投递（定时任务入口）。
 * Deliver due items for every organization (timer job entry).
 */
export async function sweepDeliveries(limit = 200) {
  return deliverDue({ limit });
}
