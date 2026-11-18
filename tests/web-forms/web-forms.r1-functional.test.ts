/**
 * 网页表单 第一轮：功能测试（新建与默认值、同名、字段与必填校验、负责人与市场活动校验、修改审计、重新生成地址、列表筛选、
 * 删除后线索保留；公开配置只含显示信息、停用与无效地址 404；公开提交生成线索（来源、负责人、市场活动、只保存启用字段）、
 * 提交计数、通知负责人、审计无操作人并打码；必填、未启用字段、邮箱格式、多余字段校验；诱饵字段；负责人停用时不分配；
 * 同一 IP 限流、请求体过大、非法 JSON；线索详情显示来源表单；回收站恢复时表单已删除则置空；演示数据）。
 * Web forms round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_WEB_FORMS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as campaigns from '@/app/api/campaigns/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as publicForm from '@/app/api/public/web-forms/[key]/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import * as regen from '@/app/api/web-forms/[id]/regenerate-key/route';
import * as formItem from '@/app/api/web-forms/[id]/route';
import * as forms from '@/app/api/web-forms/route';
import { prisma } from '@/server/db';
import { resetWebFormLimiter } from '@/server/modules/web-forms';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let campaign: { id: string };
let ipSeq = 0;
const newForm = (body: object = {}) => call(forms.POST, { token: a.token, body: { name: '官网咨询', title: '联系我们', ...body } });
const patch = (id: string, body: object) => call(formItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });
/** 每次提交使用不同 IP，避免触发同 IP 限流 / a fresh IP per submission so the per-IP limit does not interfere */
const submit = (key: string, body: object, ip = `10.0.0.${++ipSeq}`) => call(publicForm.POST, { params: { key }, body, headers: { 'x-forwarded-for': ip } });
const view = (key: string) => call(publicForm.GET, { params: { key } });

beforeEach(async () => {
  await resetDb();
  resetWebFormLimiter();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '销售甲');
  campaign = (await call(campaigns.POST, { token: a.token, body: { name: '官网改版推广', type: 'ADVERTISEMENT' } })).json;
});

describe('web forms R1 maintenance', () => {
  it('新建默认值、同名、字段与引用校验、修改审计、列表筛选 / create, validate, update', async () => {
    const r = await newForm();
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '官网咨询', title: '联系我们', isActive: true, fields: ['company', 'email', 'phone', 'description'], requiredFields: [], source: 'WEBSITE', ownerId: null, submissionCount: 0 });
    expect(r.json.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await newForm({ name: ' 官网咨询 ' })).json.error.details).toEqual({ name: ['taken'] });
    expect((await newForm({ name: 'EXPO' })).status).toBe(201);
    expect((await newForm({ name: 'expo' })).status).toBe(409);
    // 字段按固定顺序保存并去重 / fields are stored in the fixed order without duplicates
    const ordered = await newForm({ name: '顺序', fields: ['description', 'email', 'company', 'email'], requiredFields: ['email'] });
    expect(ordered.json).toMatchObject({ fields: ['company', 'email', 'description'], requiredFields: ['email'] });
    // 校验 / validation
    expect((await newForm({ name: '必填未启用', fields: ['email'], requiredFields: ['mobile'] })).json.error.details).toEqual({ requiredFields: ['not_enabled:mobile'] });
    for (const body of [{ title: ' ' }, { fields: ['fax'] }, { source: 'TV' }, { organizationId: a.org.id }, { publicKey: 'x'.repeat(43) }, { submissionCount: 9 }]) {
      expect((await newForm({ name: '非法', ...body })).status).toBe(400);
    }
    const b = await createTenant('B');
    expect((await newForm({ name: '他人', ownerId: b.user.id })).status).toBe(400);
    expect((await newForm({ name: '活动', campaignId: '00000000-0000-4000-8000-000000000000' })).json.error.details).toEqual({ campaignId: ['not_found'] });

    // 修改与审计 / update and audit
    const id = r.json.id;
    const up = await patch(id, { ownerId: rep.user.id, campaignId: campaign.id, fields: ['company', 'email'], requiredFields: ['email'], intro: '欢迎', isActive: false });
    expect(up.json).toMatchObject({ owner: { id: rep.user.id }, campaign: { id: campaign.id, name: '官网改版推广' }, isActive: false });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'webform.update', entityId: id } });
    expect(log.changes).toEqual({
      fields: {
        intro: [null, '[redacted]'],
        isActive: [true, false],
        fields: [['company', 'email', 'phone', 'description'], ['company', 'email']],
        requiredFields: [[], ['email']],
        ownerId: [null, rep.user.id],
        campaignId: [null, campaign.id],
      },
    });
    // 去掉已必填的字段时必须同时取消必填 / dropping a required field needs the requirement removed too
    expect((await patch(id, { fields: ['company'] })).json.error.details).toEqual({ requiredFields: ['not_enabled:email'] });
    expect((await patch(id, { name: 'expo' })).status).toBe(409);
    // 列表筛选 / list filters
    const names = async (query: Record<string, string>) => (await call(forms.GET, { token: a.token, query })).json.items.map((f: { name: string }) => f.name).sort();
    expect(await names({ active: 'false' })).toEqual(['官网咨询']);
    expect(await names({ q: '顺序' })).toEqual(['顺序']);
    expect(await names({})).toEqual(['EXPO', '官网咨询', '顺序']);
  });

  it('重新生成地址：旧地址失效；删除表单：线索保留且来源置空 / regenerate and delete', async () => {
    const f = (await newForm()).json;
    expect((await submit(f.publicKey, { name: '张三' })).status).toBe(200);
    const g = await call(regen.POST, { token: a.token, params: { id: f.id } });
    expect(g.json.publicKey).not.toBe(f.publicKey);
    expect((await view(f.publicKey)).status).toBe(404);
    expect((await submit(f.publicKey, { name: '李四' })).status).toBe(404);
    expect((await submit(g.json.publicKey, { name: '李四' })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'webform.regenerate_key', entityId: f.id } })).toBe(1);
    // 详情列出最近线索 / detail lists recent leads
    const detail = (await call(formItem.GET, { token: a.token, params: { id: f.id } })).json;
    expect(detail.leads.map((l: { name: string }) => l.name)).toEqual(['李四', '张三']);
    expect(detail.submissionCount).toBe(2);
    // 删除 / delete
    expect((await call(formItem.DELETE, { token: a.token, params: { id: f.id }, method: 'DELETE' })).status).toBe(204);
    const leads = await prisma.lead.findMany();
    expect(leads).toHaveLength(2);
    expect(leads.every((l) => l.webFormId === null)).toBe(true);
    const del = await prisma.auditLog.findFirstOrThrow({ where: { action: 'webform.delete', entityId: f.id } });
    expect((del.changes as { before: Record<string, unknown> }).before).toMatchObject({ name: '官网咨询', submissionCount: 2 });
    expect((await call(formItem.GET, { token: a.token, params: { id: f.id } })).status).toBe(404);
  });
});

describe('web forms R1 public', () => {
  it('公开配置只含显示信息；停用、未知、格式错误的地址 404 / public settings', async () => {
    const f = (await newForm({ intro: '留下联系方式', fields: ['company', 'email'], requiredFields: ['email'], successMessage: '谢谢', ownerId: rep.user.id })).json;
    const r = await view(f.publicKey);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      title: '联系我们',
      intro: '留下联系方式',
      fields: [
        { name: 'company', required: false },
        { name: 'email', required: true },
      ],
      successMessage: '谢谢',
    });
    expect((await view('A'.repeat(43))).status).toBe(404);
    expect((await view('bad key!')).status).toBe(404);
    expect((await view('short')).status).toBe(404);
    await patch(f.id, { isActive: false });
    expect((await view(f.publicKey)).status).toBe(404);
    expect((await submit(f.publicKey, { name: '张三', email: 'z@example.com' })).status).toBe(404);
  });

  it('提交生成线索：来源、负责人、市场活动、启用字段、计数、通知、审计 / submission creates a lead', async () => {
    const f = (await newForm({ fields: ['company', 'email', 'description'], requiredFields: ['email'], source: 'ADVERTISEMENT', ownerId: rep.user.id, campaignId: campaign.id, successMessage: '谢谢' })).json;
    const r = await submit(f.publicKey, { name: ' 张三 ', company: '甲公司', email: 'Zhang.San@Example.com', description: '想了解 13L 增压器价格' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, successMessage: '谢谢' });
    const lead = await prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({
      organizationId: a.org.id,
      name: '张三',
      company: '甲公司',
      email: 'zhang.san@example.com',
      description: '想了解 13L 增压器价格',
      phone: null,
      source: 'ADVERTISEMENT',
      status: 'NEW',
      ownerId: rep.user.id,
      campaignId: campaign.id,
      webFormId: f.id,
    });
    const form = await prisma.webForm.findUniqueOrThrow({ where: { id: f.id } });
    expect(form.submissionCount).toBe(1);
    expect(form.lastSubmittedAt).not.toBeNull();
    // 通知负责人 / the owner is notified
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: rep.user.id } });
    expect(n).toMatchObject({ type: 'WEB_FORM_LEAD', leadId: lead.id, actorId: null, title: '张三 · 官网咨询' });
    // 审计：无操作人、注明表单、邮箱打码、留言只记已修改、记录来源 IP / audit: no actor, form name, masked email, redacted message, IP
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.create', entityId: lead.id } });
    expect(log.actorId).toBeNull();
    expect(log.ip).toMatch(/^10\.0\.0\./);
    expect(log.changes).toMatchObject({ webForm: '官网咨询', after: { name: '张三', email: 'z***@example.com', description: '[redacted]', source: 'ADVERTISEMENT' } });
    // 线索详情显示来源表单 / the lead detail shows the source form
    expect((await call(leadItem.GET, { token: a.token, params: { id: lead.id } })).json.webForm).toEqual({ id: f.id, name: '官网咨询' });
  });

  it('提交校验、诱饵字段、负责人停用、限流、请求体过大 / validation, honeypot, inactive owner, limits', async () => {
    const f = (await newForm({ fields: ['company', 'email'], requiredFields: ['email'], ownerId: rep.user.id })).json;
    const err = async (body: object) => (await submit(f.publicKey, body)).json.error.details;
    expect(await err({ name: '张三' })).toEqual({ email: ['required'] });
    expect(await err({ name: '张三', email: 'z@example.com', mobile: '13800000000' })).toEqual({ mobile: ['not_enabled'] });
    expect((await submit(f.publicKey, { name: '张三', email: 'not-an-email' })).status).toBe(400);
    expect((await submit(f.publicKey, { name: ' ', email: 'z@example.com' })).status).toBe(400);
    expect((await submit(f.publicKey, { name: '张三', email: 'z@example.com', ownerId: rep.user.id })).status).toBe(400);
    expect((await submit(f.publicKey, { name: '张三', email: 'z@example.com', status: 'QUALIFIED' })).status).toBe(400);
    expect(await prisma.lead.count()).toBe(0);
    // 诱饵字段：返回成功但不保存 / honeypot: success without saving
    const bot = await submit(f.publicKey, { name: 'bot', email: 'bot@example.com', website: 'http://spam.example' });
    expect(bot.json.ok).toBe(true);
    expect(await prisma.lead.count()).toBe(0);
    expect((await prisma.webForm.findUniqueOrThrow({ where: { id: f.id } })).submissionCount).toBe(0);
    // 负责人停用：线索不分配、不通知 / inactive owner: unassigned, no notification
    await prisma.user.update({ where: { id: rep.user.id }, data: { isActive: false } });
    expect((await submit(f.publicKey, { name: '王五', email: 'w@example.com' })).status).toBe(200);
    expect((await prisma.lead.findFirstOrThrow()).ownerId).toBeNull();
    expect(await prisma.notification.count()).toBe(0);
    // 同一 IP 10 分钟内最多 5 次 / at most 5 per IP per 10 minutes
    resetWebFormLimiter();
    const same = [];
    for (let i = 0; i < 6; i += 1) same.push((await submit(f.publicKey, { name: `访客${i}`, email: `v${i}@example.com` }, '192.0.2.9')).status);
    expect(same).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await submit(f.publicKey, { name: '另一个', email: 'o@example.com' }, '192.0.2.10')).status).toBe(200);
    // 请求体过大、非法 JSON / oversized and malformed bodies
    const big = await call(publicForm.POST, { params: { key: f.publicKey }, rawBody: JSON.stringify({ name: '大', email: 'b@example.com', company: 'x'.repeat(17 * 1024) }), headers: { 'x-forwarded-for': '192.0.2.11' } });
    expect(big.status).toBe(413);
    const bad = await call(publicForm.POST, { params: { key: f.publicKey }, rawBody: '{not json', headers: { 'x-forwarded-for': '192.0.2.12' } });
    expect(bad.status).toBe(400);
  });

  it('回收站恢复线索：来源表单已删除时置空 / restoring a lead clears a deleted form', async () => {
    const f = (await newForm()).json;
    await submit(f.publicKey, { name: '张三' });
    const lead = await prisma.lead.findFirstOrThrow();
    expect((await call(leadItem.DELETE, { token: a.token, params: { id: lead.id }, method: 'DELETE' })).status).toBe(204);
    await call(formItem.DELETE, { token: a.token, params: { id: f.id }, method: 'DELETE' });
    const item = (await call(bin.GET, { token: a.token, query: { entityType: 'lead' } })).json.items[0];
    const r = await call(restore.POST, { token: a.token, params: { id: item.id } });
    expect(r.status).toBe(200);
    expect(r.json.skipped).toContain('webForm');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).webFormId).toBeNull();
  });

  it('演示网页表单 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const list = await prisma.webForm.findMany({ where: { organizationId: org.id }, include: { _count: { select: { leads: true } } } });
    expect(list.map((f) => f.name).sort()).toEqual(DEMO_WEB_FORMS.map((f) => f.name).sort());
    for (const seed of DEMO_WEB_FORMS) {
      const f = list.find((x) => x.name === seed.name)!;
      expect(f.isActive).toBe(seed.isActive);
      expect(f.submissionCount).toBe(f._count.leads);
      expect(f.requiredFields.every((x) => f.fields.includes(x))).toBe(true);
    }
    expect(list.find((f) => f.name === DEMO_WEB_FORMS[0]!.name)!._count.leads).toBe(DEMO_WEB_FORMS[0]!.linkLeads);
    // 演示表单可以公开访问并提交 / the demo form works publicly
    const active = list.find((f) => f.name === DEMO_WEB_FORMS[0]!.name)!;
    expect((await view(active.publicKey)).json.title).toBe(DEMO_WEB_FORMS[0]!.title);
    await seedDemo({ reset: true });
    expect(await prisma.webForm.count({ where: { organizationId: org.id } })).toBe(DEMO_WEB_FORMS.length);
  });
});
