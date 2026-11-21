/**
 * 自定义字段 第一轮：功能测试（定义：新建与键、校验、同名、上限 30、修改、类型不可改、勾选不能必填、启停、删除清除值、权限、审计；
 * 取值：各类型的校验与规范化、未知与停用字段、清除、编辑只改提交的键、必填（新建与提交 custom 的编辑；批量不受影响）、
 * 四个对象都可用、审计中的变化与文本脱敏；导出追加列；导入按同名列导入与校验）。
 * Custom fields round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as fieldItem from '@/app/api/custom-fields/[id]/route';
import * as fields from '@/app/api/custom-fields/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leadBulk from '@/app/api/leads/bulk/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
const newField = (body: object, token = a.token) => call(fields.POST, { token, body: { entity: 'LEAD', label: '字段', type: 'TEXT', ...body } });
const patchField = (id: string, body: object) => call(fieldItem.PATCH, { token: a.token, params: { id }, body, method: 'PATCH' });
const newLead = (custom?: object) => call(leads.POST, { token: a.token, body: { name: '线索', ...(custom ? { custom } : {}) } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
});

describe('custom fields R1 definitions', () => {
  it('新建、校验、同名、修改、启停、删除清除值、权限、审计 / definitions', async () => {
    const r = await newField({ label: '意向产品', type: 'PICKLIST', options: ['A', 'B'], required: true });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ entity: 'LEAD', label: '意向产品', type: 'PICKLIST', options: ['A', 'B'], required: true, isActive: true, position: 0 });
    expect(r.json.key).toMatch(/^cf_[a-z0-9]{8}$/);
    expect((await newField({ label: ' 意向产品 ' })).json.error.details).toEqual({ label: ['taken'] });
    expect((await newField({ entity: 'DEAL', label: '意向产品' })).status).toBe(201); // 不同对象可同名 / same name on another entity
    const bad: object[] = [
      { label: ' ' },
      { type: 'COLOR' },
      { type: 'PICKLIST' },
      { type: 'TEXT', options: ['x'] },
      { type: 'PICKLIST', options: ['A', 'a'] },
      { type: 'CHECKBOX', required: true },
      { entity: 'TICKET' },
      { key: 'cf_custom1' },
    ];
    for (const [i, body] of bad.entries()) expect((await newField({ label: `非法${i}`, ...body })).status, JSON.stringify(body)).toBe(400);
    expect((await newField({ label: '经理建' }, mgr.token)).status).toBe(403);
    expect((await call(fields.GET, { token: mgr.token, query: { entity: 'LEAD' } })).json.items).toHaveLength(1);
    // 修改：标签、选项、必填；类型不可改；勾选不能设必填 / update
    const id = r.json.id;
    expect((await patchField(id, { label: '意向产品线', options: ['A', 'B', 'C'], required: false })).json).toMatchObject({ label: '意向产品线', options: ['A', 'B', 'C'], required: false });
    expect((await patchField(id, { type: 'TEXT' })).status).toBe(400);
    expect((await patchField(id, { options: [] })).json.error.details).toEqual({ options: ['required'] });
    const cb = (await newField({ label: '经销商', type: 'CHECKBOX' })).json;
    expect((await patchField(cb.id, { required: true })).json.error.details).toEqual({ required: ['not_allowed'] });
    expect((await patchField(cb.id, { options: ['x'] })).json.error.details).toEqual({ options: ['not_allowed'] });
    // 删除：清除各记录的值 / delete clears values
    await newLead({ [r.json.key]: 'A' });
    await newLead({ [r.json.key]: 'B', [cb.key]: true });
    const del = await call(fieldItem.DELETE, { token: a.token, params: { id }, method: 'DELETE' });
    expect(del.json).toEqual({ cleared: 2 });
    const rows = await prisma.lead.findMany({ select: { custom: true } });
    expect(rows.every((l) => !(r.json.key in (l.custom as object)))).toBe(true);
    expect(rows.some((l) => (l.custom as Record<string, unknown>)[cb.key] === true)).toBe(true);
    const logs = (await prisma.auditLog.findMany({ where: { entityType: 'customfield' }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(logs).toEqual(['customfield.create', 'customfield.create', 'customfield.update', 'customfield.create', 'customfield.delete']);
  });

  it('每个对象最多 30 个 / at most 30 per entity', async () => {
    await prisma.customField.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ organizationId: a.org.id, entity: 'LEAD' as const, key: `cf_${String(i).padStart(8, '0')}`, label: `f${i}`, type: 'TEXT' as const, position: i })) });
    expect((await newField({ label: '第 31 个' })).json.error.details).toEqual({ label: ['limit_reached'] });
    expect((await newField({ label: '商机的', entity: 'DEAL' })).status).toBe(201);
  });
});

describe('custom fields R1 values', () => {
  it('各类型校验与规范化；未知、停用；清除；只改提交的键；审计脱敏 / values', async () => {
    const f = {
      text: (await newField({ label: '文本' })).json.key,
      area: (await newField({ label: '长文本', type: 'TEXTAREA' })).json.key,
      num: (await newField({ label: '数量', type: 'NUMBER' })).json.key,
      date: (await newField({ label: '日期', type: 'DATE' })).json.key,
      pick: (await newField({ label: '等级', type: 'PICKLIST', options: ['A', 'B'] })).json.key,
      cb: (await newField({ label: '勾选', type: 'CHECKBOX' })).json.key,
      url: (await newField({ label: '网址', type: 'URL' })).json.key,
      mail: (await newField({ label: '邮箱', type: 'EMAIL' })).json.key,
    };
    const ok = await newLead({ [f.text]: '  你好 ', [f.num]: '0012.50', [f.date]: '2026-02-28', [f.pick]: 'B', [f.cb]: false, [f.url]: 'https://example.com/x', [f.mail]: 'A@Example.com', [f.area]: '' });
    expect(ok.status).toBe(201);
    expect(ok.json.custom).toEqual({ [f.text]: '你好', [f.num]: '12.5', [f.date]: '2026-02-28', [f.pick]: 'B', [f.cb]: false, [f.url]: 'https://example.com/x', [f.mail]: 'a@example.com' });
    const bad: [object, string][] = [
      [{ [f.num]: '1e5' }, 'invalid_number'],
      [{ [f.num]: '1.23456' }, 'invalid_number'],
      [{ [f.date]: '2026-02-30' }, 'invalid_date'],
      [{ [f.pick]: 'C' }, 'invalid_option'],
      [{ [f.cb]: 'yes' }, 'invalid'],
      [{ [f.url]: 'javascript:alert(1)' }, 'invalid_url'],
      [{ [f.mail]: 'x@' }, 'invalid_email'],
      [{ [f.text]: 'x'.repeat(256) }, 'too_long'],
      [{ [f.text]: 5 }, 'invalid'],
      [{ cf_unknown01: 'x' }, 'unknown_field'],
    ];
    for (const [custom, code] of bad) {
      const r = await newLead(custom);
      expect(r.status, JSON.stringify(custom)).toBe(400);
      expect(Object.values(r.json.error.details)).toEqual([[code]]);
    }
    expect((await call(leads.POST, { token: a.token, body: { name: 'x', custom: 'abc' } })).status).toBe(400);
    // 停用字段不能填写，已有值保留 / inactive fields reject input and keep values
    const textField = await prisma.customField.findFirstOrThrow({ where: { key: f.text } });
    await patchField(textField.id, { isActive: false });
    expect((await call(leadItem.PATCH, { token: a.token, params: { id: ok.json.id }, body: { custom: { [f.text]: '新' } }, method: 'PATCH' })).json.error.details).toEqual({ [`custom.${f.text}`]: ['unknown_field'] });
    // 编辑只改提交的键；null 清除 / edits change only sent keys; null clears
    const up = await call(leadItem.PATCH, { token: a.token, params: { id: ok.json.id }, body: { custom: { [f.pick]: 'A', [f.mail]: null } }, method: 'PATCH' });
    expect(up.json.custom).toEqual({ [f.text]: '你好', [f.num]: '12.5', [f.date]: '2026-02-28', [f.pick]: 'A', [f.cb]: false, [f.url]: 'https://example.com/x' });
    // 不提交 custom 的编辑不动值 / edits without custom leave values alone
    expect((await call(leadItem.PATCH, { token: a.token, params: { id: ok.json.id }, body: { name: '改名' }, method: 'PATCH' })).json.custom[f.pick]).toBe('A');
    // 审计：按字段名称，文本类脱敏 / audits by label, text-like redacted
    const created = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.create', entityId: ok.json.id } });
    expect((created.changes as { custom: Record<string, unknown> }).custom).toEqual({
      文本: [null, '[redacted]'],
      数量: [null, '12.5'],
      日期: [null, '2026-02-28'],
      等级: [null, 'B'],
      勾选: [null, false],
      网址: [null, '[redacted]'],
      邮箱: [null, '[redacted]'],
    });
    const updated = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.update', entityId: ok.json.id }, orderBy: { createdAt: 'asc' } });
    expect(updated.changes).toMatchObject({ custom: { 等级: ['B', 'A'], 邮箱: ['[redacted]', null] } });
  });

  it('必填：新建、提交 custom 的编辑检查；批量不受影响；四个对象都可用 / required and all entities', async () => {
    const req = (await newField({ label: '来源渠道', required: true })).json.key;
    expect((await newLead()).json.error.details).toEqual({ [`custom.${req}`]: ['required'] });
    const old = await prisma.lead.create({ data: { organizationId: a.org.id, name: '旧线索', ownerId: a.user.id } });
    // 批量改状态不提交 custom：不受影响 / bulk edits without custom are unaffected
    expect((await call(leadBulk.POST, { token: a.token, body: { action: 'status', ids: [old.id], status: 'CONTACTED' } })).json.succeeded).toEqual([old.id]);
    // 表单编辑提交 custom：必须补齐 / form edits sending custom must fill it
    expect((await call(leadItem.PATCH, { token: a.token, params: { id: old.id }, body: { custom: {} }, method: 'PATCH' })).status).toBe(400);
    expect((await call(leadItem.PATCH, { token: a.token, params: { id: old.id }, body: { custom: { [req]: '展会' } }, method: 'PATCH' })).status).toBe(200);
    // 客户、联系人、商机 / accounts, contacts, deals
    const ak = (await newField({ entity: 'ACCOUNT', label: '预算', type: 'NUMBER' })).json.key;
    const ck = (await newField({ entity: 'CONTACT', label: '微信', type: 'TEXT' })).json.key;
    const dk = (await newField({ entity: 'DEAL', label: '交付', type: 'PICKLIST', options: ['海运', '空运'] })).json.key;
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户', custom: { [ak]: 300 } } })).json;
    expect(acc.custom).toEqual({ [ak]: '300' });
    expect((await call(accountItem.PATCH, { token: a.token, params: { id: acc.id }, body: { custom: { [ak]: 'abc' } }, method: 'PATCH' })).status).toBe(400);
    const contact = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '联系人', custom: { [ck]: 'wx_1' } } })).json;
    expect(contact.custom).toEqual({ [ck]: 'wx_1' });
    expect((await call(contactItem.PATCH, { token: a.token, params: { id: contact.id }, body: { custom: { [ck]: null } }, method: 'PATCH' })).json.custom).toEqual({});
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, custom: { [dk]: '海运' } } })).json;
    expect(deal.custom).toEqual({ [dk]: '海运' });
    expect((await call(dealItem.PATCH, { token: a.token, params: { id: deal.id }, body: { custom: { [dk]: '陆运' } }, method: 'PATCH' })).json.error.details).toEqual({ [`custom.${dk}`]: ['invalid_option'] });
    // 跨对象的键不能用 / keys of another entity are rejected
    expect((await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, custom: { [ak]: '1' } } })).json.error.details).toEqual({ [`custom.${ak}`]: ['unknown_field'] });
  });
});

describe('custom fields R1 import and export', () => {
  it('导出追加启用字段列；导入按同名列导入并校验 / export and import', async () => {
    const pick = (await newField({ label: '等级', type: 'PICKLIST', options: ['A', 'B'] })).json.key;
    const cb = (await newField({ label: '重点', type: 'CHECKBOX' })).json.key;
    const off = (await newField({ label: '停用的' })).json;
    await patchField(off.id, { isActive: false });
    await newLead({ [pick]: 'A', [cb]: true });
    const res = await leadExport.GET(new Request('http://localhost/api/leads/export', { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    const csv = (await res.text()).replace(/^﻿/, '');
    const [header, row] = csv.split('\r\n');
    expect(header!.endsWith(',等级,重点')).toBe(true);
    expect(row!.endsWith(',A,是')).toBe(true);
    // 导入：同名列；勾选接受“是/否”；非法值与必填 / import by column name
    await patchField((await prisma.customField.findFirstOrThrow({ where: { key: pick } })).id, { required: true });
    const csvIn = ['姓名,等级,重点', '甲,B,是', '乙,C,否', '丙,,no'].join('\r\n');
    const r = await call(leadImport.POST, { token: a.token, body: { csv: csvIn, dryRun: false, duplicates: 'create' } });
    expect(r.json).toMatchObject({ created: 1, unknownColumns: [] });
    expect(r.json.errors).toEqual([
      { row: 3, field: '等级', reason: 'invalid_value' },
      { row: 4, field: '等级', reason: 'required' },
    ]);
    const imported = await prisma.lead.findFirstOrThrow({ where: { name: '甲' } });
    expect(imported.custom).toEqual({ [pick]: 'B', [cb]: true });
  });
});
