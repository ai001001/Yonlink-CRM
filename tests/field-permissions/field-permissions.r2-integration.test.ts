/**
 * 字段权限 第二轮：集成测试（导出去掉隐藏列；导入拒绝受限字段；时间线与审计日志去掉隐藏字段；自定义报表的字段目录、
 * 预览、已保存报表；查重不按隐藏字段匹配、合并不能改受限字段；关联记录（客户下的联系人、联系人列表、商机联系人角色、
 * 工单联系人、看板、报价单客户、线索转化结果）；删除自定义字段时设置随之删除；跨组织隔离；API 密钥同样受限；演示数据；删除角色与分配并发不死锁）。
 * Field permissions round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountExport from '@/app/api/accounts/export/route';
import * as accounts from '@/app/api/accounts/route';
import * as apiKeys from '@/app/api/api-keys/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as contacts from '@/app/api/contacts/route';
import * as customFieldItem from '@/app/api/custom-fields/[id]/route';
import * as customFields from '@/app/api/custom-fields/route';
import * as reportRun from '@/app/api/custom-reports/[id]/run/route';
import * as userItem from '@/app/api/admin/users/[id]/route';
import * as roleItem from '@/app/api/roles/[id]/route';
import * as roleList from '@/app/api/roles/route';
import * as reportFields from '@/app/api/custom-reports/fields/route';
import * as reports from '@/app/api/custom-reports/route';
import * as preview from '@/app/api/custom-reports/run/route';
import * as contactRoles from '@/app/api/deals/[id]/contact-roles/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as board from '@/app/api/deals/board/route';
import * as deals from '@/app/api/deals/route';
import * as merge from '@/app/api/duplicates/merge/route';
import * as products from '@/app/api/products/route';
import * as duplicates from '@/app/api/duplicates/route';
import * as fieldPerms from '@/app/api/field-permissions/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leads from '@/app/api/leads/route';
import * as quoteItem from '@/app/api/quotes/[id]/route';
import * as quotes from '@/app/api/quotes/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import * as timeline from '@/app/api/timeline/route';
import { translate } from '@/i18n';
import { prisma } from '@/server/db';
import { parseCsv } from '@/server/csv';
import { DEMO_FIELD_PERMISSIONS, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;

const put = (body: object, token = a.token) => call(fieldPerms.PUT, { token, body, method: 'PUT' });
const zh = (key: Parameters<typeof translate>[1]) => translate('zh-CN', key);

/** 读取导出的 CSV / read an exported CSV */
async function csv(handler: typeof leadExport.GET, token: string) {
  const res = await handler(new Request('http://localhost/api/x', { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  expect(res.status).toBe(200);
  return parseCsv(await res.text());
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('field permissions R2 export and import', () => {
  it('导出去掉隐藏列与隐藏的自定义字段；导入拒绝受限字段 / exports drop hidden columns; imports refuse restricted fields', async () => {
    const budget = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '预算', type: 'NUMBER' } })).json;
    const secret = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '内部备注', type: 'TEXT', required: true } })).json;
    await call(leads.POST, { token: a.token, body: { name: '导出线索', phone: '13800005555', email: 'e@example.com', custom: { [budget.key]: 10, [secret.key]: '机密' } } });
    await put({ entity: 'LEAD', role: 'MANAGER', rules: { phone: 'HIDDEN', description: 'HIDDEN', title: 'READ_ONLY', [`custom.${secret.key}`]: 'HIDDEN' } });
    const [head, row] = await csv(leadExport.GET, mgr.token);
    expect(head).not.toContain(zh('leads.phone'));
    expect(head).not.toContain(zh('common.description'));
    expect(head).not.toContain('内部备注');
    expect(head).toContain(zh('leads.jobTitle'));
    expect(head).toContain('预算');
    expect(row).toHaveLength(head!.length);
    expect(row).not.toContain('13800005555');
    expect(row).not.toContain('机密');
    expect(row![head!.indexOf(zh('leads.email'))]).toBe('e@example.com');
    const [adminHead, adminRow] = await csv(leadExport.GET, a.token);
    expect(adminHead).toContain(zh('leads.phone'));
    expect(adminRow).toContain('机密');
    // 客户导出：隐藏地址列，数字格式列仍对应 / accounts: the hidden address column is dropped
    await call(accounts.POST, { token: a.token, body: { name: '导出客户', address: '机密地址 1 号', website: 'https://x.example' } });
    await put({ entity: 'ACCOUNT', role: 'MANAGER', rules: { address: 'HIDDEN' } });
    const [ah, ar] = await csv(accountExport.GET, mgr.token);
    expect(ah).not.toContain(zh('accounts.address'));
    expect(ar).not.toContain('机密地址 1 号');
    expect(ar![ah!.indexOf(zh('accounts.website'))]).toBe('https://x.example');
    // 导入：只读或隐藏的列有值则该行报错；不可编辑的必填自定义字段不要求 / import: restricted values fail the row; restricted required custom fields are not required
    const imp = await call(leadImport.POST, { token: mgr.token, body: { csv: 'name,title,email\n甲,,a@example.com\n乙,总监,b@example.com', dryRun: true } });
    expect(imp.status).toBe(200);
    expect(imp.json.valid).toBe(1);
    expect(imp.json.errors).toEqual([{ row: 3, field: 'title', reason: 'not_editable' }]);
    const imp2 = await call(leadImport.POST, { token: mgr.token, body: { csv: `name,phone,内部备注\n丙,138,x`, dryRun: true } });
    expect(imp2.json.errors).toEqual(expect.arrayContaining([{ row: 2, field: 'phone', reason: 'not_editable' }, { row: 2, field: '内部备注', reason: 'not_editable' }]));
    const imp3 = await call(leadImport.POST, { token: a.token, body: { csv: 'name\n丁', dryRun: true } });
    expect(imp3.json.errors).toEqual([{ row: 2, field: '内部备注', reason: 'required' }]);
  });
});

describe('field permissions R2 timeline, audit and reports', () => {
  it('时间线与审计日志去掉隐藏字段 / timeline and audit log drop hidden fields', async () => {
    const cf = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '底价', type: 'NUMBER' } })).json;
    const lead = (await call(leads.POST, { token: a.token, body: { name: '审计线索', title: '采购', phone: '13800006666', custom: { [cf.key]: 1 } } })).json;
    await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { title: '经理', phone: '13800007777', custom: { [cf.key]: 2 } }, method: 'PATCH' });
    // 能看审计日志的自定义角色（基于经理）/ a custom role (on the manager role) that can read the audit log
    const auditor = (await call(roleList.POST, { token: a.token, body: { name: '审计经理', baseRole: 'MANAGER', permissions: ['record.read.all', 'audit.read'] } })).json;
    expect((await call(userItem.PATCH, { token: a.token, params: { id: mgr.user.id }, body: { customRoleId: auditor.id }, method: 'PATCH' })).status).toBe(200);
    await put({ entity: 'LEAD', customRoleId: auditor.id, rules: { phone: 'HIDDEN', [`custom.${cf.key}`]: 'HIDDEN' } });
    type Entry = { action: string; changes: { after?: object; fields?: object; custom?: object } };
    const entries = (await call(timeline.GET, { token: mgr.token, query: { entity: 'lead', id: lead.id } })).json.items.filter((i: { kind: string }) => i.kind === 'audit').map((i: { entry: Entry }) => i.entry) as Entry[];
    const created = entries.find((e) => e.action === 'lead.create')!;
    const updated = entries.find((e) => e.action === 'lead.update')!;
    expect(created.changes.after).not.toHaveProperty('phone');
    expect(created.changes.after).toHaveProperty('title', '采购');
    expect(created.changes.custom).toEqual({});
    expect(updated.changes.fields).toEqual({ title: ['采购', '经理'] });
    expect(updated.changes.custom).toEqual({});
    const logs = (await call(auditLogs.GET, { token: mgr.token, query: { entityType: 'lead' } })).json.items as Entry[];
    expect(logs.find((e) => e.action === 'lead.update')!.changes.fields).toEqual({ title: ['采购', '经理'] });
    // 管理员看到完整记录（电话按审计策略脱敏）/ admins see everything (phones masked by the audit policy)
    const adminLogs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'lead' } })).json.items as Entry[];
    expect(Object.keys(adminLogs.find((e) => e.action === 'lead.update')!.changes.fields!)).toEqual(expect.arrayContaining(['title', 'phone']));
    expect(adminLogs.find((e) => e.action === 'lead.update')!.changes.custom).toHaveProperty('底价');
  });

  it('自定义报表：字段目录、预览、已保存报表 / custom reports: catalogue, preview, saved reports', async () => {
    await call(leads.POST, { token: a.token, body: { name: '报表线索', email: 'r@example.com' } });
    await put({ entity: 'LEAD', role: 'MANAGER', rules: { email: 'HIDDEN', title: 'READ_ONLY' } });
    const cat = (await call(reportFields.GET, { token: mgr.token })).json;
    expect(Object.keys(cat.fields.LEAD)).not.toContain('email');
    expect(Object.keys(cat.fields.LEAD)).toContain('title');
    expect(Object.keys((await call(reportFields.GET, { token: a.token })).json.fields.LEAD)).toContain('email');
    const def = { entity: 'LEAD', columns: ['name', 'email'] };
    const denied = await call(preview.POST, { token: mgr.token, body: def });
    expect(denied.status).toBe(403);
    expect(denied.json.error.details).toEqual({ email: ['field_hidden'] });
    expect((await call(preview.POST, { token: mgr.token, body: { entity: 'LEAD', columns: ['name'], filters: [{ field: 'email', op: 'NOT_EMPTY' }] } })).status).toBe(403);
    expect((await call(preview.POST, { token: mgr.token, body: { entity: 'LEAD', columns: ['name', 'title'] } })).status).toBe(200);
    expect((await call(reports.POST, { token: mgr.token, body: { ...def, name: '经理的报表' } })).status).toBe(403);
    const shared = (await call(reports.POST, { token: a.token, body: { ...def, name: '共享邮箱报表', shared: true } })).json;
    expect((await call(reportRun.GET, { token: a.token, params: { id: shared.id } })).json.rows[0].values.email).toBe('r@example.com');
    expect((await call(reportRun.GET, { token: mgr.token, params: { id: shared.id } })).status).toBe(403);
  });
});

describe('field permissions R2 duplicates and related records', () => {
  it('查重不按隐藏字段匹配，合并不能改受限字段 / duplicates ignore hidden fields; merges cannot change restricted fields', async () => {
    const l1 = (await call(leads.POST, { token: a.token, body: { name: '张三', company: '甲公司', email: 'z@example.com', phone: '13800000111' } })).json;
    const l2 = (await call(leads.POST, { token: a.token, body: { name: '张三', company: '甲公司', email: 'z@example.com', phone: '13800000222' } })).json;
    await call(leads.POST, { token: a.token, body: { name: '李四', email: 'only@example.com' } });
    await call(leads.POST, { token: a.token, body: { name: '王五', email: 'ONLY@example.com' } });
    await put({ entity: 'LEAD', role: 'MANAGER', rules: { email: 'HIDDEN', phone: 'READ_ONLY' } });
    type Group = { reasons: string[]; records: { id: string; email?: string }[] };
    const adminGroups = (await call(duplicates.GET, { token: a.token, query: { entity: 'leads' } })).json.groups as Group[];
    expect(adminGroups).toHaveLength(2);
    const mgrGroups = (await call(duplicates.GET, { token: mgr.token, query: { entity: 'leads' } })).json.groups as Group[];
    expect(mgrGroups).toHaveLength(1);
    expect(mgrGroups[0]!.reasons).toEqual(['nameCompany']);
    expect(mgrGroups[0]!.records.every((r) => !('email' in r))).toBe(true);
    const bad = await call(merge.POST, { token: mgr.token, body: { entity: 'leads', masterId: l1.id, duplicateIds: [l2.id], fields: { phone: l2.id } } });
    expect(bad.status).toBe(403);
    expect(bad.json.error.details).toEqual({ phone: ['field_read_only'] });
    expect(await prisma.lead.count({ where: { id: l2.id } })).toBe(1);
    expect((await call(merge.POST, { token: mgr.token, body: { entity: 'leads', masterId: l1.id, duplicateIds: [l2.id], fields: {} } })).status).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l1.id } })).phone).toBe('13800000111');
  });

  it('关联记录中的隐藏字段 / hidden fields inside related records', async () => {
    await put({ entity: 'CONTACT', role: 'SALES', rules: { phone: 'HIDDEN', email: 'HIDDEN' } });
    await put({ entity: 'ACCOUNT', role: 'SALES', rules: { phone: 'HIDDEN', address: 'HIDDEN' } });
    await put({ entity: 'DEAL', role: 'SALES', rules: { description: 'HIDDEN' } });
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '关联客户', phone: '010-1', address: '某地', ownerId: sales.user.id } })).json;
    const ct = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '联系人甲', phone: '139', email: 'c@example.com', title: '主管' } })).json;
    const detail = (await call(accountItem.GET, { token: sales.token, params: { id: acc.id } })).json;
    expect(detail).not.toHaveProperty('phone');
    expect(detail).not.toHaveProperty('address');
    expect(detail.contacts[0]).toMatchObject({ name: '联系人甲', title: '主管' });
    expect(detail.contacts[0]).not.toHaveProperty('phone');
    expect((await call(accountContacts.GET, { token: sales.token, params: { id: acc.id } })).json.items[0]).not.toHaveProperty('email');
    expect((await call(contacts.GET, { token: sales.token })).json.items[0]).not.toHaveProperty('email');
    expect((await call(contacts.GET, { token: sales.token, query: { q: 'c@example' } })).json.total).toBe(0);
    expect((await call(accounts.GET, { token: sales.token, query: { q: '010-1' } })).json.total).toBe(0);
    // 商机：看板、联系人角色 / deals: board and contact roles
    const deal = (await call(deals.POST, { token: a.token, body: { name: '关联商机', accountId: acc.id, amount: '100', description: '底牌', ownerId: sales.user.id } })).json;
    await call(contactRoles.POST, { token: a.token, params: { id: deal.id }, body: { contactId: ct.id, role: 'DECISION_MAKER' } });
    const cards = (await call(board.GET, { token: sales.token })).json.columns.flatMap((c: { items: object[] }) => c.items);
    expect(cards).toHaveLength(1);
    expect(cards[0]).not.toHaveProperty('description');
    const roles = (await call(contactRoles.GET, { token: sales.token, params: { id: deal.id } })).json;
    expect(roles.roles[0].contact).toMatchObject({ name: '联系人甲', title: '主管' });
    expect(roles.roles[0].contact).not.toHaveProperty('phone');
    // 工单联系人、报价单客户 / ticket contacts and quote accounts
    const tk = (await call(tickets.POST, { token: a.token, body: { subject: '工单', accountId: acc.id, contactId: ct.id, ownerId: sales.user.id } })).json;
    const tkView = (await call(ticketItem.GET, { token: sales.token, params: { id: tk.id } })).json;
    expect(tkView.contact).toMatchObject({ name: '联系人甲' });
    expect(tkView.contact).not.toHaveProperty('email');
    expect((await call(ticketItem.GET, { token: a.token, params: { id: tk.id } })).json.contact.email).toBe('c@example.com');
    const product = (await call(products.POST, { token: a.token, body: { sku: 'P-1', name: '产品', unitPrice: '100' } })).json;
    await call(dealItems.POST, { token: a.token, params: { id: deal.id }, body: { productId: product.id, quantity: '1' } });
    const qRes = await call(quotes.POST, { token: a.token, body: { dealId: deal.id } });
    expect(qRes.status, JSON.stringify(qRes.json)).toBe(201);
    const q = qRes.json;
    const qView = (await call(quoteItem.GET, { token: sales.token, params: { id: q.id } })).json;
    expect(qView.deal.account).toMatchObject({ name: '关联客户' });
    expect(qView.deal.account).not.toHaveProperty('phone');
    expect((await call(quoteItem.GET, { token: a.token, params: { id: q.id } })).json.deal.account.phone).toBe('010-1');
    // 线索转化结果 / lead conversion result
    const lead = (await call(leads.POST, { token: sales.token, body: { name: '待转化', company: '转化公司', phone: '13800008888' } })).json;
    const conv = (await call(convert.POST, { token: sales.token, params: { id: lead.id }, body: { account: { mode: 'new' } } })).json;
    expect(conv.account).toMatchObject({ name: '转化公司' });
    expect(conv.account).not.toHaveProperty('phone');
    expect(conv.lead).toHaveProperty('phone', '13800008888');
  });
});

describe('field permissions R2 lifecycle, isolation and API keys', () => {
  it('删除自定义字段、跨组织隔离、API 密钥 / custom field deletion, tenant isolation, API keys', async () => {
    const cf = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '临时', type: 'TEXT' } })).json;
    await put({ entity: 'LEAD', role: 'SALES', rules: { phone: 'HIDDEN', [`custom.${cf.key}`]: 'READ_ONLY' } });
    expect((await call(customFieldItem.DELETE, { token: a.token, params: { id: cf.id }, method: 'DELETE' })).status).toBe(200);
    expect(await prisma.fieldPermission.findMany({ where: { organizationId: a.org.id }, select: { field: true } })).toEqual([{ field: 'phone' }]);
    // 跨组织：B 的设置看不到 A；A 的规则不影响 B；不能引用 A 的自定义角色 / tenants: B never sees A, A's rules do not apply to B, A's roles are unknown to B
    const b = await createTenant('B');
    const bSales = await addUser(b.org.id, 'SALES', 'B销售');
    expect((await call(fieldPerms.GET, { token: b.token, query: { entity: 'LEAD' } })).json.rules).toEqual({});
    const bLead = (await call(leads.POST, { token: bSales.token, body: { name: 'B 线索', phone: '13900000000' } })).json;
    expect(bLead.phone).toBe('13900000000');
    const aRole = (await prisma.customRole.create({ data: { organizationId: a.org.id, name: 'A 的角色', baseRole: 'SALES', permissions: [] } })).id;
    expect((await call(fieldPerms.PUT, { token: b.token, body: { entity: 'LEAD', customRoleId: aRole, rules: { phone: 'HIDDEN' } }, method: 'PUT' })).status).toBe(404);
    expect(await prisma.fieldPermission.count({ where: { customRoleId: aRole } })).toBe(0);
    // API 密钥以绑定用户的身份受限 / API keys are restricted as their bound user
    const key = (await call(apiKeys.POST, { token: a.token, body: { name: '集成', userId: sales.user.id } })).json.key as string;
    const lead = (await call(leads.POST, { token: a.token, body: { name: '密钥线索', phone: '13800009999', ownerId: sales.user.id } })).json;
    expect((await call(leadItem.GET, { token: key, params: { id: lead.id } })).json).not.toHaveProperty('phone');
    expect((await call(leadItem.PATCH, { token: key, params: { id: lead.id }, body: { phone: '1' }, method: 'PATCH' })).status).toBe(403);
  });
});

describe('field permissions R2 demo data', () => {
  it('演示数据含字段权限，重置后不重复 / demo data has field permissions and a reset does not duplicate them', async () => {
    await seedDemo();
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.fieldPermission.findMany({ where: { organizationId: org.id }, select: { entity: true, field: true, role: true, access: true } });
    expect(rows).toHaveLength(DEMO_FIELD_PERMISSIONS.length);
    const viewer = await addUser(org.id, 'READONLY', '演示只读');
    const lead = await prisma.lead.findFirstOrThrow({ where: { organizationId: org.id, phone: { not: null } } });
    const seen = (await call(leadItem.GET, { token: viewer.token, params: { id: lead.id } })).json;
    expect(seen).toHaveProperty('name');
    expect(seen).not.toHaveProperty('phone');
    expect(seen).not.toHaveProperty('mobile');
  });
});

describe('field permissions R2 role deletion concurrency', () => {
  it('删除角色与分配角色并发：不出现死锁，结果一致（重复 5 轮）/ deleting vs assigning a role: no deadlock, consistent results (5 rounds)', async () => {
    const users = await Promise.all(Array.from({ length: 4 }, (_, i) => addUser(a.org.id, 'SALES', `并发${i}`)));
    for (let round = 0; round < 5; round++) {
      const role = (await call(roleList.POST, { token: a.token, body: { name: `并发角色${round}`, baseRole: 'SALES', permissions: ['record.create'] } })).json;
      await put({ entity: 'LEAD', customRoleId: role.id, rules: { phone: 'HIDDEN' } });
      const [del, ...assigned] = await Promise.all([
        call(roleItem.DELETE, { token: a.token, params: { id: role.id }, method: 'DELETE' }),
        ...users.map((u) => call(userItem.PATCH, { token: a.token, params: { id: u.user.id }, body: { customRoleId: role.id }, method: 'PATCH' })),
      ]);
      const holders = await prisma.user.count({ where: { customRoleId: role.id } });
      expect([204, 409], JSON.stringify(del.json)).toContain(del.status);
      for (const r of assigned) expect([200, 400], JSON.stringify(r.json)).toContain(r.status);
      if (del.status === 204) {
        expect(holders).toBe(0);
        expect(await prisma.fieldPermission.count({ where: { customRoleId: role.id } })).toBe(0);
      } else expect(holders).toBeGreaterThan(0);
      expect(assigned.filter((r) => r.status === 200)).toHaveLength(holders);
      await prisma.user.updateMany({ where: { customRoleId: role.id }, data: { customRoleId: null } });
    }
  });
});
