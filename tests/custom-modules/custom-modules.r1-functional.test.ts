/**
 * 自定义模块 第一轮：功能测试（模块：新建、校验、同名、上限、修改、启停、删除限制、权限、审计；字段：类型、选项、
 * 必填、上限、修改、停用、删除清值；记录：新建、取值校验、必填、可见范围、编辑与删除权限、负责人指派、关联客户、
 * 按客户跨模块查询、停用模块只读、审计脱敏）。
 * Custom modules round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as fieldItem from '@/app/api/custom-module-fields/[id]/route';
import * as moduleFields from '@/app/api/custom-modules/[id]/fields/route';
import * as moduleItem from '@/app/api/custom-modules/[id]/route';
import * as modules from '@/app/api/custom-modules/route';
import * as recordItem from '@/app/api/custom-records/[id]/route';
import * as records from '@/app/api/custom-records/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;
let ro: Awaited<ReturnType<typeof addUser>>;

const newModule = (body: object, token = a.token) => call(modules.POST, { token, body: { name: '合同', ...body } });
const newField = (moduleId: string, body: object, token = a.token) => call(moduleFields.POST, { token, params: { id: moduleId }, body: { label: '字段', type: 'TEXT', ...body } });
const newRecord = (body: object, token = a.token) => call(records.POST, { token, body: { name: '记录', ...body } });
const patchRecord = (id: string, body: object, token = a.token) => call(recordItem.PATCH, { token, params: { id }, body, method: 'PATCH' });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
  ro = await addUser(a.org.id, 'READONLY', '只读');
});

describe('custom modules R1 definitions', () => {
  it('模块：新建、校验、同名、修改、启停、权限、审计 / modules', async () => {
    const m = await newModule({ name: '合同', description: '销售合同' });
    expect(m.status).toBe(201);
    expect(m.json).toMatchObject({ name: '合同', description: '销售合同', isActive: true, position: 0 });
    expect((await newModule({ name: ' 合同 ' })).json.error.details).toEqual({ name: ['taken'] });
    expect((await newModule({ name: ' ' })).status).toBe(400);
    expect((await newModule({ name: 'x'.repeat(51) })).status).toBe(400);
    expect((await newModule({ name: '设备', extra: 1 })).status).toBe(400);
    // 只有管理员能维护；所有用户可读 / admins maintain; everyone reads
    for (const u of [mgr, sales, ro]) expect((await newModule({ name: `模块${u.user.id.slice(0, 4)}` }, u.token)).status).toBe(403);
    expect((await call(modules.GET, { token: sales.token })).json.items).toEqual([expect.objectContaining({ name: '合同' })]);
    expect((await call(modules.GET, { token: sales.token })).json.items[0]._count).toBeUndefined();
    expect((await call(modules.GET, { token: a.token })).json.items[0]._count).toEqual({ fields: 0, records: 0 });
    const up = await call(moduleItem.PATCH, { token: a.token, params: { id: m.json.id }, body: { name: '销售合同', isActive: false }, method: 'PATCH' });
    expect(up.json).toMatchObject({ name: '销售合同', isActive: false });
    expect((await call(modules.GET, { token: sales.token, query: { active: 'true' } })).json.items).toEqual([]);
    expect((await call(moduleItem.PATCH, { token: mgr.token, params: { id: m.json.id }, body: { isActive: true }, method: 'PATCH' })).status).toBe(403);
    const logs = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entityType: 'module' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['module.create', 'module.update']);
    expect(logs[1]!.changes).toMatchObject({ fields: { name: ['合同', '销售合同'], isActive: [true, false] } });
    // 上限 10 个 / cap of 10
    for (let i = 0; i < 9; i++) expect((await newModule({ name: `模块${i}` })).status).toBe(201);
    expect((await newModule({ name: '第十一个' })).json.error.details).toEqual({ name: ['limit_reached'] });
  });

  it('字段：类型、选项、必填、修改、停用、删除清值 / fields', async () => {
    const m = (await newModule({})).json;
    const bad: object[] = [
      { type: 'PICKLIST' },
      { type: 'TEXT', options: ['a'] },
      { type: 'CHECKBOX', required: true },
      { type: 'PICKLIST', options: ['a', 'A'] },
      { type: 'SPACE' },
      { label: ' ' },
    ];
    for (const body of bad) expect((await newField(m.id, body)).status, JSON.stringify(body)).toBe(400);
    const amount = (await newField(m.id, { label: '金额', type: 'NUMBER', required: true })).json;
    expect(amount).toMatchObject({ label: '金额', type: 'NUMBER', required: true, position: 0 });
    expect(amount.key).toMatch(/^cf_[0-9a-f]{8}$/);
    const kind = (await newField(m.id, { label: '类型', type: 'PICKLIST', options: ['年度', '单次'] })).json;
    expect((await newField(m.id, { label: '金额' })).json.error.details).toEqual({ label: ['taken'] });
    expect((await newField(m.id, { label: '负责人' }, sales.token)).status).toBe(403);
    // 不同模块可同名 / same label in another module is fine
    const other = (await newModule({ name: '设备' })).json;
    expect((await newField(other.id, { label: '金额' })).status).toBe(201);
    expect((await call(fieldItem.PATCH, { token: a.token, params: { id: amount.id }, body: { options: ['x'] }, method: 'PATCH' })).status).toBe(400);
    expect((await call(fieldItem.PATCH, { token: a.token, params: { id: kind.id }, body: { options: [] }, method: 'PATCH' })).status).toBe(400);
    expect((await call(fieldItem.PATCH, { token: a.token, params: { id: kind.id }, body: { options: ['年度', '单次', '框架'], label: '合同类型' }, method: 'PATCH' })).json).toMatchObject({ label: '合同类型', options: ['年度', '单次', '框架'] });
    // 读取：模块详情含字段 / module detail carries fields
    const detail = (await call(moduleItem.GET, { token: sales.token, params: { id: m.id } })).json;
    expect(detail.fields.map((f: { label: string }) => f.label)).toEqual(['金额', '合同类型']);
    // 删除字段清除各记录中的值 / deleting a field clears values
    await newRecord({ moduleId: m.id, custom: { [amount.key]: '10', [kind.key]: '年度' } });
    await newRecord({ moduleId: m.id, custom: { [amount.key]: '20' } });
    const del = await call(fieldItem.DELETE, { token: a.token, params: { id: kind.id }, method: 'DELETE' });
    expect(del.json).toEqual({ cleared: 1 });
    const rows = await prisma.customRecord.findMany({ where: { moduleId: m.id } });
    expect(rows.every((r) => !(kind.key in (r.values as object)))).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entityType: 'module', entityId: m.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((l) => l.action)).toEqual(['module.create', 'module.field_create', 'module.field_create', 'module.field_update', 'module.field_delete']);
    // 有记录的模块不能删除；清空后可删除 / modules with records cannot be deleted
    expect((await call(moduleItem.DELETE, { token: a.token, params: { id: m.id }, method: 'DELETE' })).json.error.details).toEqual({ module: ['has_records'] });
    await prisma.customRecord.deleteMany({ where: { moduleId: m.id } });
    expect((await call(moduleItem.DELETE, { token: a.token, params: { id: m.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.customModuleField.count({ where: { moduleId: m.id } })).toBe(0);
  });
});

describe('custom modules R1 records', () => {
  it('记录：取值校验、必填、关联客户、负责人、审计脱敏 / values, required, account, owner, audit', async () => {
    const m = (await newModule({})).json;
    const amount = (await newField(m.id, { label: '金额', type: 'NUMBER', required: true })).json;
    const note = (await newField(m.id, { label: '条款', type: 'TEXTAREA' })).json;
    const signed = (await newField(m.id, { label: '已签', type: 'CHECKBOX' })).json;
    expect((await newRecord({ moduleId: m.id })).json.error.details).toEqual({ [`custom.${amount.key}`]: ['required'] });
    expect((await newRecord({ moduleId: m.id, custom: { [amount.key]: 'abc' } })).json.error.details).toEqual({ [`custom.${amount.key}`]: ['invalid_number'] });
    expect((await newRecord({ moduleId: m.id, custom: { [amount.key]: '1', cf_00000000: 'x' } })).json.error.details).toEqual({ 'custom.cf_00000000': ['unknown_field'] });
    expect((await newRecord({ moduleId: m.id, name: ' ', custom: { [amount.key]: '1' } })).status).toBe(400);
    const b = await createTenant('B');
    const bAcct = (await call(accounts.POST, { token: b.token, body: { name: 'B客户' } })).json;
    expect((await newRecord({ moduleId: m.id, accountId: bAcct.id, custom: { [amount.key]: '1' } })).json.error.details).toEqual({ accountId: ['not_found'] });
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '客户甲' } })).json;
    const r = await newRecord({ moduleId: m.id, name: '2026 年度合同', accountId: acct.id, ownerId: sales.user.id, custom: { [amount.key]: 12.5, [note.key]: '保密条款', [signed.key]: true } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '2026 年度合同', owner: { id: sales.user.id }, account: { id: acct.id, name: '客户甲' }, module: { name: '合同' }, values: { [amount.key]: '12.5', [note.key]: '保密条款', [signed.key]: true } });
    // 编辑只改提交的键；清除 / edits change only sent keys; clearing
    const up = await patchRecord(r.json.id, { custom: { [note.key]: null } });
    expect(up.json.values).toEqual({ [amount.key]: '12.5', [signed.key]: true });
    expect((await patchRecord(r.json.id, { custom: { [amount.key]: '' } })).json.error.details).toEqual({ [`custom.${amount.key}`]: ['required'] });
    expect((await patchRecord(r.json.id, { name: '改名' })).json.name).toBe('改名');
    const logs = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entityType: 'customrecord' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['customrecord.create', 'customrecord.update', 'customrecord.update']);
    expect(logs[0]!.changes).toMatchObject({ module: '合同', after: { name: '2026 年度合同', ownerId: sales.user.id, accountId: acct.id }, custom: { 金额: [null, '12.5'], 条款: [null, '[redacted]'], 已签: [null, true] } });
    expect(JSON.stringify(logs)).not.toContain('保密条款');
    expect(logs[2]!.changes).toMatchObject({ fields: { name: ['2026 年度合同', '改名'] } });
    // 审计日志接口可按对象筛选 / the audit API filters by entity
    expect((await call(auditLogs.GET, { token: a.token, query: { entityType: 'customrecord' } })).json.items).toHaveLength(3);
    // 停用字段：不能填写，已有值保留 / inactive fields: read-only, values kept
    await call(fieldItem.PATCH, { token: a.token, params: { id: signed.id }, body: { isActive: false }, method: 'PATCH' });
    expect((await patchRecord(r.json.id, { custom: { [signed.key]: false } })).json.error.details).toEqual({ [`custom.${signed.key}`]: ['unknown_field'] });
    expect((await call(recordItem.GET, { token: a.token, params: { id: r.json.id } })).json.values[signed.key]).toBe(true);
  });

  it('可见范围与权限；按客户跨模块；停用模块只读 / visibility, rights, by account, inactive module', async () => {
    const m = (await newModule({})).json;
    const eq = (await newModule({ name: '设备' })).json;
    const acct = (await call(accounts.POST, { token: sales.token, body: { name: '销售的客户' } })).json;
    const other = (await call(accounts.POST, { token: a.token, body: { name: '管理员的客户' } })).json;
    const own = await newRecord({ moduleId: m.id, name: '销售的合同', accountId: acct.id }, sales.token);
    expect(own.json.owner.id).toBe(sales.user.id);
    // 销售：不能指派给他人，不能关联不可见客户 / sales: no assigning to others, no invisible accounts
    expect((await newRecord({ moduleId: m.id, ownerId: mgr.user.id }, sales.token)).status).toBe(403);
    expect((await newRecord({ moduleId: m.id, accountId: other.id }, sales.token)).json.error.details).toEqual({ accountId: ['not_found'] });
    const mine = await newRecord({ moduleId: eq.id, name: '经理的设备', accountId: acct.id, ownerId: mgr.user.id });
    const names = async (token: string, query: Record<string, string>) => ((await call(records.GET, { token, query })).json.items as { name: string }[]).map((x) => x.name).sort();
    expect(await names(sales.token, { moduleId: m.id })).toEqual(['销售的合同']);
    expect(await names(sales.token, { moduleId: eq.id })).toEqual([]);
    expect(await names(mgr.token, { accountId: acct.id })).toEqual(['销售的合同', '经理的设备'].sort());
    expect(await names(ro.token, { moduleId: m.id, q: '合同' })).toEqual(['销售的合同']);
    expect((await call(records.GET, { token: a.token, query: {} })).status).toBe(400);
    expect((await call(recordItem.GET, { token: sales.token, params: { id: mine.json.id } })).status).toBe(404);
    // 编辑与删除 / edit and delete rights
    expect((await patchRecord(own.json.id, { name: '改' }, ro.token)).status).toBe(403);
    expect((await patchRecord(own.json.id, { name: '销售改名' }, sales.token)).json.name).toBe('销售改名');
    expect((await patchRecord(own.json.id, { ownerId: mgr.user.id }, sales.token)).status).toBe(403);
    expect((await patchRecord(own.json.id, { name: '经理改名' }, mgr.token)).json.name).toBe('经理改名');
    expect((await call(recordItem.DELETE, { token: sales.token, params: { id: own.json.id }, method: 'DELETE' })).status).toBe(403);
    // 停用模块：记录只读，按客户查询时不含 / inactive module: read-only, left out of the account view
    await call(moduleItem.PATCH, { token: a.token, params: { id: eq.id }, body: { isActive: false }, method: 'PATCH' });
    expect((await patchRecord(mine.json.id, { name: '改' })).json.error.details).toEqual({ module: ['inactive'] });
    expect((await newRecord({ moduleId: eq.id })).json.error.details).toEqual({ module: ['inactive'] });
    expect(await names(mgr.token, { accountId: acct.id })).toEqual(['经理改名']);
    expect(await names(mgr.token, { moduleId: eq.id })).toEqual(['经理的设备']);
    // 删除：管理员与经理 / delete by managers
    expect((await call(recordItem.DELETE, { token: mgr.token, params: { id: own.json.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.customRecord.count({ where: { id: own.json.id } })).toBe(0);
    const del = await prisma.auditLog.findFirstOrThrow({ where: { action: 'customrecord.delete' } });
    expect(del.changes).toMatchObject({ module: '合同', before: { name: '经理改名' } });
    // 跨组织：B 看不到 A 的模块与记录 / cross-tenant
    const b = await createTenant('B');
    expect((await call(modules.GET, { token: b.token })).json.items).toEqual([]);
    expect((await call(moduleItem.GET, { token: b.token, params: { id: m.id } })).status).toBe(404);
    expect((await call(recordItem.GET, { token: b.token, params: { id: mine.json.id } })).status).toBe(404);
    expect((await call(records.GET, { token: b.token, query: { moduleId: m.id } })).status).toBe(404);
    expect((await newRecord({ moduleId: m.id }, b.token)).status).toBe(404);
  });
});
