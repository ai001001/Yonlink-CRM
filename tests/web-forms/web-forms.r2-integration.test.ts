/**
 * 网页表单 第二轮：集成测试（角色权限：所有人可查看、仅管理员与经理可维护；表单详情的最近线索按可见范围过滤；跨组织隔离与
 * 数据库触发器；公开接口不读取登录令牌，线索只归属表单所在组织；通知中心收到表单线索；并发提交计数准确；每个表单每小时上限；
 * 跨域预检；审计日志接口筛选）。
 * Web forms round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as leads from '@/app/api/leads/route';
import * as notifications from '@/app/api/notifications/route';
import * as publicForm from '@/app/api/public/web-forms/[key]/route';
import * as regen from '@/app/api/web-forms/[id]/regenerate-key/route';
import * as formItem from '@/app/api/web-forms/[id]/route';
import * as forms from '@/app/api/web-forms/route';
import { prisma } from '@/server/db';
import { resetWebFormLimiter } from '@/server/modules/web-forms';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales: Who & { user: { id: string } };
let viewer: Who;
let form: { id: string; publicKey: string };
let ipSeq = 0;
const submit = (key: string, body: object, headers: Record<string, string> = {}) => call(publicForm.POST, { params: { key }, body, headers: { 'x-forwarded-for': `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`, ...headers } });

beforeEach(async () => {
  await resetDb();
  resetWebFormLimiter();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
  form = (await call(forms.POST, { token: admin.token, body: { name: '官网咨询', title: '联系我们', ownerId: sales.user.id } })).json;
});

describe('web forms R2 permissions', () => {
  it('所有人可查看；销售与只读不能维护；经理可以 / read for all, manage for admins and managers', async () => {
    for (const who of [sales, viewer]) {
      expect((await call(forms.GET, { token: who.token })).json.total).toBe(1);
      expect((await call(formItem.GET, { token: who.token, params: { id: form.id } })).json.name).toBe('官网咨询');
      for (const r of [
        await call(forms.POST, { token: who.token, body: { name: '我的', title: 'x' } }),
        await call(formItem.PATCH, { token: who.token, params: { id: form.id }, body: { isActive: false }, method: 'PATCH' }),
        await call(regen.POST, { token: who.token, params: { id: form.id } }),
        await call(formItem.DELETE, { token: who.token, params: { id: form.id }, method: 'DELETE' }),
      ]) {
        expect(r.status).toBe(403);
      }
    }
    expect(await prisma.webForm.findUniqueOrThrow({ where: { id: form.id } })).toMatchObject({ isActive: true, publicKey: form.publicKey });
    expect((await call(forms.POST, { token: manager.token, body: { name: '经理表单', title: 'x' } })).status).toBe(201);
    expect((await call(regen.POST, { token: manager.token, params: { id: form.id } })).status).toBe(200);
    // 未登录不能访问管理接口 / the management API needs a session
    expect((await call(forms.GET)).status).toBe(401);
  });

  it('表单详情的最近线索按可见范围过滤；通知中心收到表单线索 / visibility and notifications', async () => {
    await submit(form.publicKey, { name: '给销售的线索' });
    // 改为不分配后再提交一条 / then one unassigned
    await call(formItem.PATCH, { token: admin.token, params: { id: form.id }, body: { ownerId: null }, method: 'PATCH' });
    await submit(form.publicKey, { name: '未分配线索' });
    const forSales = (await call(formItem.GET, { token: sales.token, params: { id: form.id } })).json;
    expect(forSales.leads.map((l: { name: string }) => l.name)).toEqual(['给销售的线索']);
    expect(forSales.submissionCount).toBe(2);
    expect((await call(formItem.GET, { token: admin.token, params: { id: form.id } })).json.leads).toHaveLength(2);
    // 销售在线索列表中看到自己的表单线索 / the rep sees the lead in the lead list
    expect((await call(leads.GET, { token: sales.token })).json.items.map((l: { name: string }) => l.name)).toEqual(['给销售的线索']);
    // 通知中心 / notification centre
    const list = (await call(notifications.GET, { token: sales.token })).json.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'WEB_FORM_LEAD', title: '给销售的线索 · 官网咨询', actor: null });
  });
});

describe('web forms R2 isolation & robustness', () => {
  it('跨组织隔离；公开接口忽略登录令牌 / tenant isolation; the public API ignores tokens', async () => {
    expect((await call(forms.GET, { token: other.token })).json.total).toBe(0);
    for (const r of [
      await call(formItem.GET, { token: other.token, params: { id: form.id } }),
      await call(formItem.PATCH, { token: other.token, params: { id: form.id }, body: { isActive: false }, method: 'PATCH' }),
      await call(regen.POST, { token: other.token, params: { id: form.id } }),
      await call(formItem.DELETE, { token: other.token, params: { id: form.id }, method: 'DELETE' }),
    ]) {
      expect(r.status).toBe(404);
    }
    // 其他组织不能引用本组织的负责人；名称只在组织内唯一 / no cross-org owner; names unique per org only
    expect((await call(forms.POST, { token: other.token, body: { name: '官网咨询', title: 'x', ownerId: sales.user.id } })).status).toBe(400);
    expect((await call(forms.POST, { token: other.token, body: { name: '官网咨询', title: 'x' } })).status).toBe(201);
    // 带着 B 的令牌提交 A 的表单：线索仍属于 A / submitting A's form with B's token still creates A's lead
    expect((await submit(form.publicKey, { name: '访客' }, { authorization: `Bearer ${other.token}` })).status).toBe(200);
    const lead = await prisma.lead.findFirstOrThrow({ where: { name: '访客' } });
    expect(lead.organizationId).toBe(admin.org.id);
    expect((await call(leads.GET, { token: other.token })).json.total).toBe(0);
    // 数据库触发器拒绝跨组织的来源表单 / the trigger rejects a cross-org source form
    const bLead = await prisma.lead.create({ data: { organizationId: other.org.id, name: 'B 线索' } });
    await expect(prisma.lead.update({ where: { id: bLead.id }, data: { webFormId: form.id } })).rejects.toThrow();
    // 线索接口不接受客户端指定来源表单 / the lead API rejects a client-supplied web form
    expect((await call(leads.POST, { token: admin.token, body: { name: '手工', webFormId: form.id } })).status).toBe(400);
  });

  it('并发提交计数准确；每个表单每小时上限 200 / concurrent counts; per-form hourly cap', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(form.publicKey, { name: `并发${i}` })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.lead.count({ where: { webFormId: form.id } })).toBe(10);
    expect((await prisma.webForm.findUniqueOrThrow({ where: { id: form.id } })).submissionCount).toBe(10);
    expect(await prisma.notification.count({ where: { type: 'WEB_FORM_LEAD' } })).toBe(10);
    // 不同 IP 也受每表单上限约束（已用 10 次）/ the per-form cap applies across IPs (10 used)
    let last = 0;
    for (let i = 0; i < 191; i += 1) last = (await submit(form.publicKey, { name: `批量${i}` })).status;
    expect(last).toBe(429);
    expect(await prisma.lead.count({ where: { webFormId: form.id } })).toBe(200);
  }, 120_000);

  it('跨域预检与审计日志筛选 / CORS preflight and audit filter', async () => {
    const pre = await publicForm.OPTIONS(new Request('http://localhost/api/public/web-forms/x', { method: 'OPTIONS', headers: { origin: 'https://ai001001.github.io' } }));
    expect(pre.status).toBe(204);
    await call(formItem.PATCH, { token: admin.token, params: { id: form.id }, body: { title: '新标题' }, method: 'PATCH' });
    const logs = (await call(auditLogs.GET, { token: admin.token, query: { entityType: 'webform' } })).json.items;
    expect(logs.map((l: { action: string }) => l.action).sort()).toEqual(['webform.create', 'webform.update']);
  });
});
