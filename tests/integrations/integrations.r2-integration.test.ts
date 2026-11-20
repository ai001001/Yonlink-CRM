/**
 * Webhook 与 API 密钥 第二轮：集成测试（3 个进程并发处理 20 条投递：每条只发送一次；域名解析到内网地址时连接被拒；
 * 不跟随重定向；业务事务回滚时不入队；组织隔离（他组织不能查看、测试、重试；密钥只能访问绑定用户的组织）；
 * 只读用户的密钥只能读；数据库约束；审计日志按对象筛选；演示 Webhook 为停用且指向保留域名）。
 * Webhooks and API keys round 2: integration tests.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_WEBHOOK } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as apiKeys from '@/app/api/api-keys/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as leads from '@/app/api/leads/route';
import * as retry from '@/app/api/webhook-deliveries/[id]/retry/route';
import * as deliveries from '@/app/api/webhooks/[id]/deliveries/route';
import * as testRoute from '@/app/api/webhooks/[id]/test/route';
import * as webhooks from '@/app/api/webhooks/route';
import { prisma } from '@/server/db';
import { deliverDue, enqueueDelivery } from '@/server/modules/webhooks';
import { addUser, call, createTenant, resetDb } from '../helpers';

const received: { id: string; path: string }[] = [];
let mode: 'ok' | 'redirect' = 'ok';
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    received.push({ id: String(req.headers['x-yonlink-delivery']), path: req.url ?? '' });
    if (mode === 'redirect') {
      res.statusCode = 302;
      res.setHeader('location', '/elsewhere');
    } else res.statusCode = 204;
    res.end();
  });
});
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  delete process.env.WEBHOOK_ALLOW_HTTP;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  received.length = 0;
  mode = 'ok';
  process.env.WEBHOOK_ALLOW_HTTP = '1';
  process.env.WEBHOOK_ALLOW_PRIVATE = '1';
  a = await createTenant('A');
});
const newHook = async (url = `http://127.0.0.1:${port}/hook`, t = a) => (await call(webhooks.POST, { token: t.token, body: { name: `h${Math.random()}`, url } })).json as { id: string; secret: string };

describe('integrations R2 delivery', () => {
  it('3 个进程并发处理 20 条：每条只发送一次 / concurrent workers never double-send', async () => {
    const hook = await newHook();
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < 20; i++) await enqueueDelivery(tx, a.org.id, hook.id, 'workflow.run', { i });
    });
    const results = await Promise.all([deliverDue({ limit: 8 }), deliverDue({ limit: 8 }), deliverDue({ limit: 8 })]);
    const claimed = results.reduce((s, r) => s + r.claimed, 0);
    expect(claimed).toBe(20);
    expect(received).toHaveLength(20);
    expect(new Set(received.map((r) => r.id)).size).toBe(20);
    expect(await prisma.webhookDelivery.count({ where: { status: 'SUCCEEDED' } })).toBe(20);
  });

  it('域名解析到内网时连接被拒；不跟随重定向；事务回滚不入队 / DNS SSRF, redirects, rollback', async () => {
    const hook = await newHook();
    // 绕过保存校验写入 localhost 域名 → 发送时解析为回环地址被拒 / a localhost name resolves to loopback and is refused
    await prisma.webhook.update({ where: { id: hook.id }, data: { url: `http://localhost:${port}/hook` } });
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    const r = await call(testRoute.POST, { token: a.token, params: { id: hook.id } });
    expect(r.json).toMatchObject({ ok: false, error: expect.stringMatching(/private_address/) });
    expect(received).toHaveLength(0);
    process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    // 重定向视为失败，不跟随 / redirects count as failures and are not followed
    mode = 'redirect';
    const r2 = await call(testRoute.POST, { token: a.token, params: { id: hook.id } });
    expect(r2.json).toMatchObject({ ok: false, statusCode: 302, error: 'http_302' });
    expect(received.map((x) => x.path)).toEqual(['/hook']);
    // 事务回滚时投递不保留 / a rolled-back transaction leaves no delivery
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueDelivery(tx, a.org.id, hook.id, 'workflow.run', {});
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');
    expect(await prisma.webhookDelivery.count({ where: { event: 'workflow.run' } })).toBe(0);
  });
});

describe('integrations R2 isolation and data', () => {
  it('组织隔离；只读用户密钥只能读 / tenant isolation and read-only keys', async () => {
    const hook = await newHook();
    await prisma.$transaction((tx) => enqueueDelivery(tx, a.org.id, hook.id, 'workflow.run', {}));
    mode = 'redirect';
    await deliverDue();
    const d = await prisma.webhookDelivery.findFirstOrThrow();
    const b = await createTenant('B');
    expect((await call(webhooks.GET, { token: b.token })).json.items).toEqual([]);
    expect((await call(testRoute.POST, { token: b.token, params: { id: hook.id } })).status).toBe(404);
    expect((await call(deliveries.GET, { token: b.token, params: { id: hook.id } })).status).toBe(404);
    expect((await call(retry.POST, { token: b.token, params: { id: d.id } })).status).toBe(404);
    // B 的密钥只能看到 B 的数据 / B's key only sees B's data
    await call(leads.POST, { token: a.token, body: { name: 'A 线索' } });
    const bKey = (await call(apiKeys.POST, { token: b.token, body: { name: 'B', userId: b.user.id } })).json.key;
    expect((await call(leads.GET, { token: bKey })).json.total).toBe(0);
    // 只读用户的密钥 / a read-only user's key
    const viewer = await addUser(a.org.id, 'READONLY', '只读');
    const vKey = (await call(apiKeys.POST, { token: a.token, body: { name: '只读集成', userId: viewer.user.id } })).json.key;
    expect((await call(leads.GET, { token: vKey })).json.total).toBe(1);
    expect((await call(leads.POST, { token: vKey, body: { name: '不允许' } })).status).toBe(403);
  });

  it('数据库约束；审计日志按对象筛选 / database checks and audit filter', async () => {
    const hook = await newHook();
    await expect(prisma.$executeRaw`UPDATE webhooks SET url = 'ftp://x' WHERE id = ${hook.id}::uuid`).rejects.toThrow(/webhooks_check/);
    await expect(prisma.$executeRaw`UPDATE webhooks SET secret = 'short' WHERE id = ${hook.id}::uuid`).rejects.toThrow(/webhooks_check/);
    await expect(prisma.apiKey.create({ data: { organizationId: a.org.id, name: 'x', prefix: 'bad_', keyHash: 'f'.repeat(64), userId: a.user.id } })).rejects.toThrow(/api_keys_check/);
    await expect(prisma.apiKey.create({ data: { organizationId: a.org.id, name: 'x', prefix: 'ylk_1', keyHash: 'XYZ'.padEnd(64, '0'), userId: a.user.id } })).rejects.toThrow(/api_keys_check/);
    await prisma.$transaction((tx) => enqueueDelivery(tx, a.org.id, hook.id, 'workflow.run', {}));
    await expect(prisma.$executeRaw`UPDATE webhook_deliveries SET attempts = -1`).rejects.toThrow(/webhook_deliveries_check/);
    await call(apiKeys.POST, { token: a.token, body: { name: '审计', userId: a.user.id } });
    expect((await call(auditLogs.GET, { token: a.token, query: { entityType: 'apikey' } })).json.items[0]).toMatchObject({ action: 'apikey.create' });
    expect((await call(auditLogs.GET, { token: a.token, query: { entityType: 'webhook' } })).json.items[0]).toMatchObject({ action: 'webhook.create' });
  });

  it('演示数据：Webhook 已停用、指向保留域名、没有投递与密钥 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const hooks = await prisma.webhook.findMany({ where: { organizationId: org.id } });
    expect(hooks.map((h) => [h.name, h.url, h.isActive])).toEqual([[DEMO_WEBHOOK.name, DEMO_WEBHOOK.url, false]]);
    expect(new URL(hooks[0]!.url).hostname).toBe('example.com');
    expect(await prisma.webhookDelivery.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.apiKey.count({ where: { organizationId: org.id } })).toBe(0);
  });
});
