/**
 * Webhook 与 API 密钥 第一轮：功能测试（API 密钥：新建只返回一次、只存哈希、以绑定用户身份访问、可见范围、最近使用时间、
 * 吊销/过期/用户停用后 401、不能管理密钥与 Webhook 或改密码、校验与权限、审计不含密钥；Webhook：新建返回签名密钥、地址校验、
 * 工作流动作入队与负载字段、签名可验证、失败退避重试与最终失败、手动重试、连接时拒绝内网地址、测试事件、停用跳过、
 * 重新生成密钥、权限）。
 * Webhooks and API keys round 1: functional tests.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as apiKeys from '@/app/api/api-keys/route';
import * as revoke from '@/app/api/api-keys/[id]/revoke/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as password from '@/app/api/profile/password/route';
import * as retry from '@/app/api/webhook-deliveries/[id]/retry/route';
import * as deliveries from '@/app/api/webhooks/[id]/deliveries/route';
import * as hookItem from '@/app/api/webhooks/[id]/route';
import * as secretRoute from '@/app/api/webhooks/[id]/secret/route';
import * as testRoute from '@/app/api/webhooks/[id]/test/route';
import * as webhooks from '@/app/api/webhooks/route';
import * as workflows from '@/app/api/workflows/route';
import { prisma } from '@/server/db';
import { deliverDue, sign } from '@/server/modules/webhooks';
import { addUser, call, createTenant, resetDb } from '../helpers';

/** 本地接收端：记录请求，按设定返回状态码 / local receiver recording requests with a configurable status */
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let reply = 200;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.statusCode = reply;
    res.end('ok');
  });
});
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  delete process.env.WEBHOOK_ALLOW_HTTP;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let mgr: Awaited<ReturnType<typeof addUser>>;

beforeEach(async () => {
  await resetDb();
  received.length = 0;
  reply = 200;
  // 测试接收端在本机 http 上 / the test receiver is on local http
  process.env.WEBHOOK_ALLOW_HTTP = '1';
  process.env.WEBHOOK_ALLOW_PRIVATE = '1';
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
});

const newKey = (body: object, token = a.token) => call(apiKeys.POST, { token, body: { name: '集成', userId: rep.user.id, ...body } });
const newHook = (body: object = {}, token = a.token) => call(webhooks.POST, { token, body: { name: '接收端', url: `${base}/hook`, ...body } });

describe('integrations R1 API keys', () => {
  it('新建只返回一次、只存哈希、以绑定用户身份访问、最近使用时间、吊销/过期/停用 / API keys', async () => {
    const r = await newKey({});
    expect(r.status).toBe(201);
    const key = r.json.key as string;
    expect(key).toMatch(/^ylk_[A-Za-z0-9_-]{43}$/);
    expect(r.json).toMatchObject({ name: '集成', prefix: key.slice(0, 12), user: { id: rep.user.id }, revokedAt: null });
    const row = await prisma.apiKey.findFirstOrThrow();
    expect(row.keyHash).not.toContain(key);
    expect(JSON.stringify((await call(apiKeys.GET, { token: a.token })).json)).not.toContain(key.slice(12));
    // 以销售身份：只看到自己的线索 / acts as the rep: own leads only
    await call(leads.POST, { token: a.token, body: { name: '管理员的线索' } });
    await call(leads.POST, { token: rep.token, body: { name: '销售的线索' } });
    const list = await call(leads.GET, { token: key });
    expect(list.status).toBe(200);
    expect(list.json.items.map((x: { name: string }) => x.name)).toEqual(['销售的线索']);
    // 写入也以该用户身份并写审计 / writes act as the user and are audited
    const created = await call(leads.POST, { token: key, body: { name: '密钥建的线索' } });
    expect(created.json.ownerId).toBe(rep.user.id);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.create', entityId: created.json.id } })).actorId).toBe(rep.user.id);
    expect((await prisma.apiKey.findFirstOrThrow()).lastUsedAt).not.toBeNull();

    // 吊销 / revoke
    expect((await call(revoke.POST, { token: a.token, params: { id: row.id } })).json.revokedAt).not.toBeNull();
    expect((await call(leads.GET, { token: key })).status).toBe(401);
    expect((await call(revoke.POST, { token: a.token, params: { id: row.id } })).status).toBe(409);
    // 过期与用户停用 / expiry and deactivation
    const k2 = (await newKey({ name: '过期' })).json;
    await prisma.apiKey.update({ where: { id: k2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(leads.GET, { token: k2.key })).status).toBe(401);
    const k3 = (await newKey({ name: '停用' })).json;
    expect((await call(leads.GET, { token: k3.key })).status).toBe(200);
    await prisma.user.update({ where: { id: rep.user.id }, data: { isActive: false } });
    expect((await call(leads.GET, { token: k3.key })).status).toBe(401);
    expect((await call(leads.GET, { token: 'ylk_' + 'x'.repeat(43) })).status).toBe(401);
    // 审计不含密钥 / audits never hold the key
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'apikey' } });
    expect(logs.map((l) => l.action).sort()).toEqual(['apikey.create', 'apikey.create', 'apikey.create', 'apikey.revoke']);
    for (const k of [key, k2.key, k3.key]) expect(JSON.stringify(logs)).not.toContain(k.slice(12));
  });

  it('密钥不能管理密钥、Webhook、改密码；校验与权限 / key limits, validation and permissions', async () => {
    const adminKey = (await newKey({ userId: a.user.id })).json.key;
    expect((await call(apiKeys.GET, { token: adminKey })).json.error.details).toEqual({ auth: ['session_required'] });
    expect((await newKey({}, adminKey)).status).toBe(403);
    expect((await newHook({}, adminKey)).status).toBe(403);
    expect((await call(password.POST, { token: adminKey, body: { currentPassword: a.password, newPassword: 'New-Passw0rd-1' } })).status).toBe(403);
    // 但能正常调用业务接口 / business endpoints still work
    expect((await call(leads.GET, { token: adminKey })).status).toBe(200);
    const b = await createTenant('B');
    for (const body of [{ userId: b.user.id }, { name: ' ' }, { expiresOn: '2020-01-01' }, { expiresOn: 'x' }, { extra: 1 }]) expect((await newKey(body)).status, JSON.stringify(body)).toBe(400);
    expect((await newKey({}, mgr.token)).status).toBe(403);
    expect((await call(apiKeys.GET, { token: rep.token })).status).toBe(403);
    expect((await call(revoke.POST, { token: b.token, params: { id: (await prisma.apiKey.findFirstOrThrow()).id } })).status).toBe(404);
  });
});

describe('integrations R1 webhooks', () => {
  it('新建返回签名密钥、地址校验、列表不含密钥、权限 / create and validation', async () => {
    const r = await newHook();
    expect(r.status).toBe(201);
    expect(r.json.secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await call(webhooks.GET, { token: a.token })).json)).not.toContain(r.json.secret);
    expect((await newHook({ name: ' 接收端 ' })).status).toBe(409);
    // 经理可查看（选择工作流动作），不能新建；销售不能查看 / managers read, cannot create; reps cannot read
    expect((await call(webhooks.GET, { token: mgr.token })).json.items).toHaveLength(1);
    expect((await newHook({ name: '经理' }, mgr.token)).status).toBe(403);
    expect((await call(webhooks.GET, { token: rep.token })).status).toBe(403);
    // 关闭测试放行后的地址规则 / URL rules with the test allowances off
    delete process.env.WEBHOOK_ALLOW_HTTP;
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    const bad: [string, string][] = [
      ['http://example.com/x', 'https_required'],
      ['https://localhost/x', 'private_address'],
      ['https://10.1.2.3/x', 'private_address'],
      ['https://[::1]/x', 'private_address'],
      ['https://u:p@example.com/x', 'no_credentials'],
      ['ftp://example.com', 'https_required'],
      ['not a url', 'invalid_url'],
    ];
    for (const [url, code] of bad) expect((await newHook({ name: url, url })).json.error.details?.url, url).toEqual([code]);
    expect((await newHook({ name: '公网', url: 'https://example.com/hook' })).status).toBe(201);
  });

  it('工作流入队、负载、签名、成功；失败退避、最终失败、手动重试 / delivery and retries', async () => {
    const hook = (await newHook()).json;
    const rule = await call(workflows.POST, { token: a.token, body: { name: '推送', entity: 'LEAD', trigger: 'CREATE_OR_UPDATE', actions: [{ type: 'WEBHOOK', webhookId: hook.id }] } });
    expect(rule.status).toBe(201);
    expect((await call(workflows.POST, { token: a.token, body: { name: '坏', entity: 'LEAD', trigger: 'CREATE', actions: [{ type: 'WEBHOOK', webhookId: '00000000-0000-4000-8000-000000000000' }] } })).json.error.details).toEqual({ actions: ['webhook_not_found'] });
    const lead = (await call(leads.POST, { token: a.token, body: { name: '推送线索', company: '宁波汽配', email: 'x@example.com', phone: '13800000000', source: 'WEBSITE' } })).json;
    const d = await prisma.webhookDelivery.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'PENDING', attempts: 0, event: 'workflow.run' });
    const payload = d.payload as { id: string; data: { rule: string; entity: string; trigger: string; record: Record<string, unknown> } };
    expect(payload.id).toBe(d.id);
    expect(payload.data).toMatchObject({ rule: '推送', entity: 'LEAD', trigger: 'create', record: { id: lead.id, name: '推送线索', company: '宁波汽配', source: 'WEBSITE', status: 'NEW', ownerId: a.user.id } });
    expect(JSON.stringify(payload)).not.toMatch(/x@example\.com|13800000000/);

    expect(await deliverDue()).toEqual({ claimed: 1, succeeded: 1, retry: 0, failed: 0 });
    const got = received[0]!;
    expect(got.headers['x-yonlink-delivery']).toBe(d.id);
    expect(got.headers['x-yonlink-event']).toBe('workflow.run');
    const ts = Number(got.headers['x-yonlink-timestamp']);
    expect(got.headers['x-yonlink-signature']).toBe(`v1=${sign(hook.secret, ts, got.body)}`);
    expect(JSON.parse(got.body)).toEqual(d.payload);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('SUCCEEDED');
    expect(await deliverDue()).toEqual({ claimed: 0, succeeded: 0, retry: 0, failed: 0 });

    // 失败：按 1、5、30、120、360 分钟退避，第 6 次最终失败 / back-off then final failure
    reply = 500;
    await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { status: 'CONTACTED' }, method: 'PATCH' });
    const f = await prisma.webhookDelivery.findFirstOrThrow({ where: { status: 'PENDING' } });
    let clock = Date.now();
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await deliverDue({ now: () => new Date(clock) });
      expect(r.claimed).toBe(1);
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: f.id } });
      expect(row.attempts).toBe(i + 1);
      expect(row.lastStatusCode).toBe(500);
      if (row.status === 'PENDING') {
        gaps.push(Math.round((row.nextAttemptAt.getTime() - clock) / 60_000));
        clock = row.nextAttemptAt.getTime();
      } else expect(row).toMatchObject({ status: 'FAILED', lastError: 'http_500' });
    }
    expect(gaps).toEqual([1, 5, 30, 120, 360]);
    // 同一投递重试时 ID 不变 / the delivery id is stable across retries
    expect(new Set(received.slice(1).map((x) => x.headers['x-yonlink-delivery']))).toEqual(new Set([f.id]));
    // 手动重试 / manual retry
    reply = 200;
    expect((await call(retry.POST, { token: a.token, params: { id: f.id } })).json).toEqual({ status: 'PENDING' });
    expect((await call(retry.POST, { token: a.token, params: { id: f.id } })).status).toBe(409);
    expect((await deliverDue()).succeeded).toBe(1);
    const list = (await call(deliveries.GET, { token: a.token, params: { id: hook.id }, query: { status: 'SUCCEEDED' } })).json;
    expect(list.total).toBe(2);
  });

  it('连接时拒绝内网地址；测试事件；停用跳过；重新生成密钥 / SSRF, ping, inactive, secret rotation', async () => {
    const hook = (await newHook()).json;
    // 测试事件 / ping
    const ping = await call(testRoute.POST, { token: a.token, params: { id: hook.id } });
    expect(ping.json).toMatchObject({ ok: true, statusCode: 200 });
    expect(received[0]!.headers['x-yonlink-event']).toBe('ping');
    // 关闭内网放行：连接时被拒 / private addresses refused on connect
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    const blocked = await call(testRoute.POST, { token: a.token, params: { id: hook.id } });
    expect(blocked.json).toMatchObject({ ok: false, error: 'private_address' });
    expect(received).toHaveLength(1);
    process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    // 重新生成密钥后签名随之变化 / signatures follow the new secret
    const { secret } = (await call(secretRoute.POST, { token: a.token, params: { id: hook.id } })).json;
    expect(secret).not.toBe(hook.secret);
    await call(testRoute.POST, { token: a.token, params: { id: hook.id } });
    const last = received.at(-1)!;
    expect(last.headers['x-yonlink-signature']).toBe(`v1=${sign(secret, Number(last.headers['x-yonlink-timestamp']), last.body)}`);
    // 停用：工作流跳过；已入队的投递标记失败 / inactive: workflows skip; queued deliveries fail
    await call(workflows.POST, { token: a.token, body: { name: '推送', entity: 'LEAD', trigger: 'CREATE', actions: [{ type: 'WEBHOOK', webhookId: hook.id }] } });
    await call(leads.POST, { token: a.token, body: { name: '入队后停用' } });
    await call(hookItem.PATCH, { token: a.token, params: { id: hook.id }, body: { isActive: false }, method: 'PATCH' });
    await call(leads.POST, { token: a.token, body: { name: '停用后' } });
    expect(await prisma.webhookDelivery.count({ where: { event: 'workflow.run' } })).toBe(1);
    const run = await prisma.auditLog.findFirstOrThrow({ where: { action: 'workflow.run' }, orderBy: { createdAt: 'desc' } });
    expect(run.changes).toMatchObject({ skipped: ['WEBHOOK: webhook_inactive'] });
    expect(await deliverDue()).toEqual({ claimed: 1, succeeded: 0, retry: 0, failed: 1 });
    expect((await prisma.webhookDelivery.findFirstOrThrow({ where: { event: 'workflow.run' } })).lastError).toBe('webhook_inactive');
    // 审计：不含签名密钥 / audits never hold secrets
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'webhook' } });
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(hook.secret);
    // 删除：投递一并删除 / delete: deliveries go too
    expect((await call(hookItem.DELETE, { token: a.token, params: { id: hook.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });
});
