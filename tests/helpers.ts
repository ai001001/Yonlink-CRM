/**
 * 测试辅助：清库、创建组织/用户、以 HTTP 方式调用路由处理器。
 * Test helpers: reset DB, create orgs/users, call route handlers over HTTP semantics.
 */
import { randomBytes } from 'node:crypto';
import type { UserRole } from '@/generated/prisma/enums';
import { hashPassword, hashToken, resetLoginLimiter } from '@/server/auth';
import { prisma } from '@/server/db';

type Handler = (req: Request, route: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** 清空全部业务数据 / Truncate all data */
export async function resetDb(): Promise<void> {
  resetLoginLimiter();
  await prisma.$executeRawUnsafe(
    'TRUNCATE audit_logs, notifications, sales_targets, attachments, user_view_defaults, saved_views, recycle_bin_items, lead_tags, account_tags, deal_tags, tags, quote_line_items, quotes, deal_line_items, products, notes, activities, deals, contacts, accounts, leads, sessions, users, organizations RESTART IDENTITY CASCADE',
  );
}

let seq = 0;

/**
 * 创建组织 + 用户 + 会话令牌（默认系统管理员）。
 * Create an organization, a user (admin by default) and a session token.
 */
export async function createTenant(label = 'A', role: UserRole = 'ADMIN') {
  seq += 1;
  const org = await prisma.organization.create({ data: { name: `测试组织 ${label}` } });
  const password = 'Passw0rd!test';
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `user${seq}-${label.toLowerCase()}@yonlink.test`,
      name: `用户${label}${seq}`,
      role,
      passwordHash: await hashPassword(password),
    },
  });
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { org, user, token, password };
}

/**
 * 以 Request 调用路由处理器并解析 JSON。
 * Invoke a route handler with a Request and parse JSON.
 */
export async function call(
  handler: Handler,
  opts: {
    token?: string;
    body?: unknown;
    rawBody?: string;
    query?: Record<string, string>;
    params?: Record<string, string>;
    method?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const url = new URL('http://localhost/api/test');
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body }), {
    params: Promise.resolve(opts.params ?? {}),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = text ? JSON.parse(text) : null;
  return { status: res.status, json, headers: res.headers };
}

/**
 * 在已有组织中新增指定角色的用户并创建会话。
 * Add a user with the given role to an existing organization and create a session.
 */
export async function addUser(organizationId: string, role: UserRole, label: string = role) {
  seq += 1;
  const user = await prisma.user.create({
    data: { organizationId, role, email: `user${seq}-${label.toLowerCase()}@yonlink.test`, name: `${label}${seq}`, passwordHash: 'x' },
  });
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token };
}
