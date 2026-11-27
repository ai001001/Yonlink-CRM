/**
 * 字段权限 第一轮：功能测试（设置：读取字段与角色、只有管理员能改、校验、整体替换与审计、数据库约束；读取：隐藏字段不返回、
 * 管理员不受限、/me 返回规则、搜索不匹配隐藏字段；写入：隐藏字段一律拒绝、只读字段只能保持原值、新建只能留空、
 * 自定义字段同样处理、不可编辑的必填字段不要求填写；自定义角色只按自身设置；修改后立即生效）。
 * Field permissions round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as me from '@/app/api/auth/me/route';
import * as customFields from '@/app/api/custom-fields/route';
import * as fieldPerms from '@/app/api/field-permissions/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as roles from '@/app/api/roles/route';
import * as search from '@/app/api/search/route';
import * as userItem from '@/app/api/admin/users/[id]/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;

const put = (body: object, token = a.token) => call(fieldPerms.PUT, { token, body, method: 'PUT' });
const settings = (entity = 'LEAD', token = a.token) => call(fieldPerms.GET, { token, query: { entity } });
const newLead = (body: object, token: string) => call(leads.POST, { token, body: { name: '测试线索', ...body } });
const patchLead = (id: string, body: object, token: string) => call(leadItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const getLead = (id: string, token: string) => call(leadItem.GET, { token, params: { id } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('field permissions R1 settings', () => {
  it('字段与角色、权限、校验、整体替换、审计、约束 / fields and roles, permission, validation, replace, audit, checks', async () => {
    const cf = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '预算', type: 'NUMBER' } })).json;
    const role = (await call(roles.POST, { token: a.token, body: { name: '外包销售', baseRole: 'SALES', permissions: ['record.create', 'record.update.own'] } })).json;
    const s = (await settings()).json;
    expect(s.fields.map((f: { field: string }) => f.field)).toEqual(['title', 'phone', 'mobile', 'email', 'description', `custom.${cf.key}`]);
    expect(s.fields[5]).toMatchObject({ custom: true, label: '预算', isActive: true, required: false });
    expect(s.roles.map((r: { key: string }) => r.key)).toEqual(['MANAGER', 'SALES', 'READONLY', role.id]);
    expect(s.rules).toEqual({});
    expect((await settings('DEAL')).json.fields.map((f: { field: string }) => f.field)).toEqual(['description']);
    // 只有能管理用户的角色可读写 / only user managers may read and write
    for (const u of [mgr, sales]) {
      expect((await settings('LEAD', u.token)).status).toBe(403);
      expect((await put({ entity: 'LEAD', role: 'SALES', rules: { phone: 'HIDDEN' } }, u.token)).status).toBe(403);
    }
    // 校验 / validation
    const bad: [object, number, string][] = [
      [{ entity: 'LEAD', role: 'SALES', rules: { name: 'HIDDEN' } }, 400, 'rules.name'],
      [{ entity: 'LEAD', role: 'SALES', rules: { 'custom.cf_zzzzzzzz': 'HIDDEN' } }, 400, 'rules.custom.cf_zzzzzzzz'],
      [{ entity: 'DEAL', role: 'SALES', rules: { amount: 'HIDDEN' } }, 400, 'rules.amount'],
      [{ entity: 'LEAD', role: 'SALES', rules: { phone: 'SECRET' } }, 400, 'rules'],
      [{ entity: 'LEAD', role: 'ADMIN', rules: { phone: 'HIDDEN' } }, 400, 'role'],
      [{ entity: 'LEAD', rules: { phone: 'HIDDEN' } }, 400, 'role'],
      [{ entity: 'LEAD', role: 'SALES', customRoleId: role.id, rules: {} }, 400, 'role'],
    ];
    for (const [body, status, key] of bad) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(Object.keys(res.json.error.details).some((k) => k.startsWith(key)), JSON.stringify(res.json)).toBe(true);
    }
    expect((await put({ entity: 'LEAD', customRoleId: '00000000-0000-4000-8000-000000000000', rules: {} })).status).toBe(404);
    // 保存与整体替换：EDIT 不存储 / save and replace: EDIT is not stored
    const saved = await put({ entity: 'LEAD', role: 'SALES', rules: { phone: 'HIDDEN', title: 'READ_ONLY', email: 'EDIT', [`custom.${cf.key}`]: 'HIDDEN' } });
    expect(saved.status).toBe(200);
    expect(saved.json.rules).toEqual({ phone: 'HIDDEN', title: 'READ_ONLY', [`custom.${cf.key}`]: 'HIDDEN' });
    await put({ entity: 'LEAD', customRoleId: role.id, rules: { email: 'HIDDEN' } });
    expect((await settings()).json.rules).toEqual({ SALES: { phone: 'HIDDEN', title: 'READ_ONLY', [`custom.${cf.key}`]: 'HIDDEN' }, [role.id]: { email: 'HIDDEN' } });
    await put({ entity: 'LEAD', role: 'SALES', rules: { title: 'HIDDEN' } });
    expect((await settings()).json.rules.SALES).toEqual({ title: 'HIDDEN' });
    // 无变化不写审计；审计记录访问级别变化与自定义字段名称 / no audit without changes; audit records access changes and custom labels
    await put({ entity: 'LEAD', role: 'SALES', rules: { title: 'HIDDEN' } });
    const logs = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entityType: 'fieldpermission' }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(3);
    expect(logs[0]!.changes).toEqual({ entity: 'LEAD', role: 'SALES', fields: { phone: ['EDIT', 'HIDDEN'], title: ['EDIT', 'READ_ONLY'], [`custom.${cf.key}`]: ['EDIT', 'HIDDEN'] }, labels: { [`custom.${cf.key}`]: '预算' } });
    expect(logs[1]!.changes).toMatchObject({ customRole: '外包销售', fields: { email: ['EDIT', 'HIDDEN'] } });
    expect(logs[2]!.changes).toMatchObject({ fields: { phone: ['HIDDEN', 'EDIT'], title: ['READ_ONLY', 'HIDDEN'], [`custom.${cf.key}`]: ['HIDDEN', 'EDIT'] } });
    // 数据库约束：管理员、两者都填、不可限制的字段 / database checks: admins, both set, unrestricted fields
    const raw = (role: string | null, customRoleId: string | null, entity: string, field: string) =>
      prisma.$executeRawUnsafe(`INSERT INTO field_permissions (id, organization_id, entity, field, role, custom_role_id, access, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2::custom_entity, $3, $4::user_role, $5::uuid, 'HIDDEN', now())`, a.org.id, entity, field, role, customRoleId);
    await expect(raw('ADMIN', null, 'LEAD', 'phone')).rejects.toThrow(/field_permissions_check/);
    await expect(raw('SALES', role.id, 'LEAD', 'phone')).rejects.toThrow(/field_permissions_check/);
    await expect(raw(null, null, 'LEAD', 'phone')).rejects.toThrow(/field_permissions_check/);
    await expect(raw('SALES', null, 'LEAD', 'name')).rejects.toThrow(/field_permissions_check/);
    await expect(raw('SALES', null, 'DEAL', 'amount')).rejects.toThrow(/field_permissions_check/);
    await expect(raw('SALES', null, 'LEAD', 'title')).rejects.toThrow(/field_permissions_role_key/);
  });
});

describe('field permissions R1 reading', () => {
  it('隐藏字段不返回、管理员不受限、/me、搜索 / hidden fields are not returned, admins unrestricted, /me, search', async () => {
    const cf = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '底价', type: 'NUMBER' } })).json;
    const lead = (await newLead({ phone: '13800001111', email: 'x@example.com', title: '采购', ownerId: sales.user.id, custom: { [cf.key]: 99 } }, a.token)).json;
    await put({ entity: 'LEAD', role: 'SALES', rules: { phone: 'HIDDEN', title: 'READ_ONLY', [`custom.${cf.key}`]: 'HIDDEN' } });
    const mine = (await getLead(lead.id, sales.token)).json;
    expect(mine).not.toHaveProperty('phone');
    expect(mine).toMatchObject({ title: '采购', email: 'x@example.com', custom: {} });
    const list = (await call(leads.GET, { token: sales.token })).json;
    expect(list.items[0]).not.toHaveProperty('phone');
    expect(list.items[0].custom).toEqual({});
    // 管理员与经理（无规则）不受影响 / admins and managers (no rules) are unaffected
    for (const tk of [a.token, mgr.token]) expect((await getLead(lead.id, tk)).json).toMatchObject({ phone: '13800001111', custom: { [cf.key]: '99' } });
    // /me 返回当前用户的规则 / /me returns the user's rules
    expect((await call(me.GET, { token: sales.token })).json.fieldAccess).toEqual({ LEAD: { phone: 'HIDDEN', title: 'READ_ONLY', [`custom.${cf.key}`]: 'HIDDEN' } });
    expect((await call(me.GET, { token: a.token })).json.fieldAccess).toEqual({});
    // 搜索不匹配隐藏的字段（列表与全局搜索）/ search does not match hidden fields (list and global search)
    expect((await call(leads.GET, { token: sales.token, query: { q: '13800001111' } })).json.total).toBe(0);
    expect((await call(leads.GET, { token: sales.token, query: { q: 'x@example' } })).json.total).toBe(1);
    expect((await call(leads.GET, { token: a.token, query: { q: '13800001111' } })).json.total).toBe(1);
    expect((await call(search.GET, { token: sales.token, query: { q: '13800001111' } })).json.leads).toHaveLength(0);
    expect((await call(search.GET, { token: a.token, query: { q: '13800001111' } })).json.leads).toHaveLength(1);
  });
});

describe('field permissions R1 writing', () => {
  it('隐藏与只读字段的写入规则 / write rules for hidden and read-only fields', async () => {
    const cfRo = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '折扣', type: 'NUMBER' } })).json;
    const cfHid = (await call(customFields.POST, { token: a.token, body: { entity: 'LEAD', label: '成本', type: 'TEXT', required: true } })).json;
    await put({ entity: 'LEAD', role: 'SALES', rules: { phone: 'HIDDEN', title: 'READ_ONLY', [`custom.${cfRo.key}`]: 'READ_ONLY', [`custom.${cfHid.key}`]: 'HIDDEN' } });
    // 新建：只读与隐藏字段只能留空；不可编辑的必填字段不要求 / create: restricted fields stay empty; required restricted fields are not required
    expect((await newLead({ phone: '1' }, sales.token)).json.error.details).toEqual({ phone: ['field_hidden'] });
    expect((await newLead({ title: '经理' }, sales.token)).json.error.details).toEqual({ title: ['field_read_only'] });
    expect((await newLead({ custom: { [cfRo.key]: 5 } }, sales.token)).json.error.details).toEqual({ [`custom.${cfRo.key}`]: ['field_read_only'] });
    expect((await newLead({ custom: { [cfHid.key]: 'x' } }, sales.token)).json.error.details).toEqual({ [`custom.${cfHid.key}`]: ['field_hidden'] });
    const created = await newLead({ title: null, email: 'ok@example.com' }, sales.token);
    expect(created.status).toBe(201);
    // 管理员仍须填写必填字段 / admins still have to fill required fields
    expect((await newLead({}, a.token)).json.error.details).toEqual({ [`custom.${cfHid.key}`]: ['required'] });
    const lead = (await newLead({ title: '采购', phone: '13800002222', ownerId: sales.user.id, custom: { [cfRo.key]: '0.5', [cfHid.key]: '机密' } }, a.token)).json;
    // 编辑：隐藏字段即使值相同也拒绝；只读字段相同可以、不同拒绝 / edit: hidden refused even when equal; read-only equal ok, changed refused
    expect((await patchLead(lead.id, { phone: '13800002222' }, sales.token)).json.error.details).toEqual({ phone: ['field_hidden'] });
    expect((await patchLead(lead.id, { title: '采购' }, sales.token)).status).toBe(200);
    expect((await patchLead(lead.id, { title: '总监' }, sales.token)).json.error.details).toEqual({ title: ['field_read_only'] });
    expect((await patchLead(lead.id, { title: null }, sales.token)).json.error.details).toEqual({ title: ['field_read_only'] });
    expect((await patchLead(lead.id, { custom: { [cfRo.key]: '0.50' } }, sales.token)).status).toBe(200);
    expect((await patchLead(lead.id, { custom: { [cfRo.key]: 0.6 } }, sales.token)).json.error.details).toEqual({ [`custom.${cfRo.key}`]: ['field_read_only'] });
    expect((await patchLead(lead.id, { custom: { [cfHid.key]: '机密' } }, sales.token)).json.error.details).toEqual({ [`custom.${cfHid.key}`]: ['field_hidden'] });
    // 其他字段照常修改，隐藏的值保持不变 / other fields change as usual and hidden values are kept
    const ok = await patchLead(lead.id, { company: '新公司', custom: {} }, sales.token);
    expect(ok.status).toBe(200);
    expect(ok.json).not.toHaveProperty('phone');
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row).toMatchObject({ company: '新公司', phone: '13800002222', title: '采购', custom: { [cfRo.key]: '0.5', [cfHid.key]: '机密' } });
    // 管理员不受限 / admins are unrestricted
    expect((await patchLead(lead.id, { phone: '13800003333', title: '总监' }, a.token)).status).toBe(200);
  });

  it('自定义角色只按自身设置、修改立即生效 / custom roles follow their own settings; changes apply immediately', async () => {
    const lead = (await newLead({ phone: '13800004444', email: 'y@example.com', ownerId: sales.user.id }, a.token)).json;
    const role = (await call(roles.POST, { token: a.token, body: { name: '外包销售', baseRole: 'SALES', permissions: ['record.create', 'record.update.own'] } })).json;
    await put({ entity: 'LEAD', role: 'SALES', rules: { phone: 'HIDDEN' } });
    await put({ entity: 'LEAD', customRoleId: role.id, rules: { email: 'HIDDEN' } });
    expect((await getLead(lead.id, sales.token)).json).toMatchObject({ email: 'y@example.com' });
    expect((await getLead(lead.id, sales.token)).json).not.toHaveProperty('phone');
    // 分配自定义角色后只按自定义角色的设置 / with the custom role only its settings apply
    expect((await call(userItem.PATCH, { token: a.token, params: { id: sales.user.id }, body: { customRoleId: role.id }, method: 'PATCH' })).status).toBe(200);
    const asCustom = (await getLead(lead.id, sales.token)).json;
    expect(asCustom).toMatchObject({ phone: '13800004444' });
    expect(asCustom).not.toHaveProperty('email');
    // 修改设置后下一个请求立即生效 / setting changes apply on the next request
    await put({ entity: 'LEAD', customRoleId: role.id, rules: {} });
    expect((await getLead(lead.id, sales.token)).json).toMatchObject({ phone: '13800004444', email: 'y@example.com' });
    await put({ entity: 'LEAD', customRoleId: role.id, rules: { phone: 'READ_ONLY' } });
    expect((await patchLead(lead.id, { phone: '1' }, sales.token)).json.error.details).toEqual({ phone: ['field_read_only'] });
    // 删除自定义角色前须取消分配；删除后其设置随之删除 / settings go with the deleted role
    await call(userItem.PATCH, { token: a.token, params: { id: sales.user.id }, body: { customRoleId: null }, method: 'PATCH' });
    await prisma.customRole.delete({ where: { id: role.id } });
    expect(await prisma.fieldPermission.count({ where: { customRoleId: role.id } })).toBe(0);
    expect(await prisma.fieldPermission.count({ where: { organizationId: a.org.id, role: 'SALES' } })).toBe(1);
  });
});
