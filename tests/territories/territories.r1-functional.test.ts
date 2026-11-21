/**
 * 区域管理 第一轮：功能测试（区域：新建、校验、同名、负责人与成员、树形层级与环、修改、删除与清除、权限、审计；
 * 规则分配：优先级、全部/任一、无条件不分配、新建与编辑自动分配、手工指定与恢复自动、权限；重新分配；
 * 列表筛选（含下级、无区域、我的区域、商机按客户区域、导出列）；导入、线索转化、回收站恢复；统计与可见范围）。
 * Territories round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountExport from '@/app/api/accounts/export/route';
import * as accountImport from '@/app/api/accounts/import/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as auditLogs from '@/app/api/audit-logs/route';
import * as deals from '@/app/api/deals/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as leads from '@/app/api/leads/route';
import * as bin from '@/app/api/recycle-bin/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as apply from '@/app/api/territories/apply/route';
import * as territoryItem from '@/app/api/territories/[id]/route';
import * as territories from '@/app/api/territories/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let mgr: Awaited<ReturnType<typeof addUser>>;
let sales: Awaited<ReturnType<typeof addUser>>;
const newTerritory = (body: object, token = a.token) => call(territories.POST, { token, body: { name: '区域', ...body } });
const patchTerritory = (id: string, body: object, token = a.token) => call(territoryItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const delTerritory = (id: string, token = a.token) => call(territoryItem.DELETE, { token, params: { id }, method: 'DELETE' });
const newAccount = (body: object, token = a.token) => call(accounts.POST, { token, body: { name: '客户', ...body } });
const patchAccount = (id: string, body: object, token = a.token) => call(accountItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const addr = (op: string, value: string) => ({ field: 'address', op, value });
/** 列表中的客户名称 / account names in a list */
const names = async (query: Record<string, string>, token = a.token) => ((await call(accounts.GET, { token, query })).json.items as { name: string }[]).map((x) => x.name).sort();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  mgr = await addUser(a.org.id, 'MANAGER', '经理');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('territories R1 definitions', () => {
  it('新建、校验、同名、负责人与成员、修改、权限、审计 / create, validate, update, permissions, audit', async () => {
    const r = await newTerritory({ name: '华东', description: '江浙沪', managerId: mgr.user.id, memberIds: [sales.user.id, sales.user.id], priority: 20, match: 'ANY', conditions: [addr('CONTAINS', '杭州')] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: '华东', description: '江浙沪', parentId: null, priority: 20, match: 'ANY', manager: { id: mgr.user.id }, members: [{ id: sales.user.id }] });
    expect((await newTerritory({ name: ' 华东 ' })).json.error.details).toEqual({ name: ['taken'] });
    const b = await createTenant('B');
    const inactive = await addUser(a.org.id, 'SALES', '停用');
    await prisma.user.update({ where: { id: inactive.user.id }, data: { isActive: false } });
    const bad: [object, object | null][] = [
      [{ name: ' ' }, null],
      [{ priority: 0 }, null],
      [{ priority: 1000 }, null],
      [{ conditions: [{ field: 'score', op: 'GTE', value: '1' }] }, null],
      [{ conditions: [{ field: 'industry', op: 'CONTAINS', value: 'IT' }] }, null],
      [{ conditions: [{ field: 'industry', op: 'EQUALS', value: 'SPACE' }] }, null],
      [{ conditions: Array.from({ length: 11 }, () => addr('CONTAINS', 'x')) }, null],
      [{ match: 'SOME' }, null],
      [{ parentId: crypto.randomUUID() }, { parentId: ['not_found'] }],
      [{ managerId: b.user.id }, { managerId: ['not_found'] }],
      [{ memberIds: [inactive.user.id] }, { memberIds: ['not_found'] }],
    ];
    for (const [i, [body, details]] of bad.entries()) {
      const res = await newTerritory({ name: `非法${i}`, ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      if (details) expect(res.json.error.details).toEqual(details);
    }
    // 经理可维护；销售不能维护但可读取 / managers maintain; sales read only
    expect((await newTerritory({ name: '经理建' }, mgr.token)).status).toBe(201);
    expect((await newTerritory({ name: '销售建' }, sales.token)).status).toBe(403);
    expect((await patchTerritory(r.json.id, { priority: 1 }, sales.token)).status).toBe(403);
    expect((await call(apply.POST, { token: sales.token })).status).toBe(403);
    expect((await call(territories.GET, { token: sales.token })).json.items.map((x: { name: string }) => x.name).sort()).toEqual(['华东', '经理建']);
    // 选项模式：只返回 ID、上级、名称 / options mode returns ids, parents and names only
    const opts = (await call(territories.GET, { token: sales.token, query: { view: 'options' } })).json;
    expect(opts).toEqual({ items: [{ id: expect.any(String), parentId: null, name: '华东' }, { id: expect.any(String), parentId: null, name: '经理建' }] });
    expect((await call(territories.GET, { token: sales.token, query: { view: 'tree' } })).status).toBe(400);
    // 修改：成员整体替换、清空负责人 / update replaces members and clears the manager
    const u = await patchTerritory(r.json.id, { name: '华东区', managerId: null, memberIds: [mgr.user.id], conditions: [] });
    expect(u.json).toMatchObject({ name: '华东区', manager: null, members: [{ id: mgr.user.id }], conditions: [] });
    expect((await patchTerritory(r.json.id, { name: '经理建' })).json.error.details).toEqual({ name: ['taken'] });
    expect((await patchTerritory(crypto.randomUUID(), { priority: 3 })).status).toBe(404);
    // 其他组织不能修改、删除 / other organizations cannot touch it
    expect((await patchTerritory(r.json.id, { priority: 3 }, b.token)).status).toBe(404);
    expect((await delTerritory(r.json.id, b.token)).status).toBe(404);
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'territory' } })).json.items as { action: string; changes: Record<string, unknown> }[];
    expect(logs.map((l) => l.action).sort()).toEqual(['territory.create', 'territory.create', 'territory.update']);
    expect(Object.keys((logs.find((l) => l.action === 'territory.update')!.changes.fields as object) ?? {}).sort()).toEqual(['conditions', 'managerId', 'memberIds', 'name']);
  });

  it('树形：最多 3 级、不能成环；删除：有下级 409、客户变为无区域 / tree depth, cycles and delete', async () => {
    const top = (await newTerritory({ name: '一级' })).json;
    const mid = (await newTerritory({ name: '二级', parentId: top.id })).json;
    const leaf = (await newTerritory({ name: '三级', parentId: mid.id })).json;
    expect(leaf.parentId).toBe(mid.id);
    expect((await newTerritory({ name: '四级', parentId: leaf.id })).json.error.details).toEqual({ parentId: ['too_deep'] });
    expect((await patchTerritory(top.id, { parentId: leaf.id })).json.error.details).toEqual({ parentId: ['cycle'] });
    expect((await patchTerritory(top.id, { parentId: top.id })).json.error.details).toEqual({ parentId: ['cycle'] });
    const other = (await newTerritory({ name: '另一顶级' })).json;
    // 把有两级下级的“二级”移到“另一顶级”下仍为 3 级；再移到“三级”所在链下会超过 / moving keeps or exceeds depth
    expect((await patchTerritory(mid.id, { parentId: other.id })).status).toBe(200);
    const other2 = (await newTerritory({ name: '另一二级', parentId: top.id })).json;
    expect((await patchTerritory(mid.id, { parentId: other2.id })).json.error.details).toEqual({ parentId: ['too_deep'] });
    // 删除：有下级 409；叶子删除后客户变为无区域并恢复自动 / delete
    expect((await delTerritory(mid.id)).json.error.details).toEqual({ parentId: ['has_children'] });
    const acc = (await newAccount({ territoryId: leaf.id })).json;
    expect(acc).toMatchObject({ territoryId: leaf.id, territoryManual: true });
    expect((await delTerritory(leaf.id)).json).toEqual({ cleared: 1 });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).toMatchObject({ territoryId: null, territoryManual: false });
    expect((await delTerritory(mid.id)).status).toBe(200);
    const del = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'territory', action: 'territory.delete' } })).json.items as { changes: { name: string; clearedAccounts: number } }[];
    expect(del.map((d) => [d.changes.name, d.changes.clearedAccounts]).sort()).toEqual([['三级', 1], ['二级', 0]]);
  });
});

describe('territories R1 assignment', () => {
  it('规则：优先级、全部/任一、无条件不分配、新建与编辑自动分配 / rules on create and edit', async () => {
    const cn = (await newTerritory({ name: '国内', priority: 50, conditions: [addr('STARTS_WITH', '国内')] })).json;
    const east = (await newTerritory({ name: '华东', parentId: cn.id, priority: 10, match: 'ANY', conditions: [addr('CONTAINS', '杭州'), addr('CONTAINS', '常州')] })).json;
    const it2 = (await newTerritory({ name: '国内IT', priority: 10, match: 'ALL', conditions: [addr('STARTS_WITH', '国内'), { field: 'industry', op: 'EQUALS', value: 'IT' }] })).json;
    await newTerritory({ name: '空规则', priority: 1 });
    expect((await newAccount({ address: '国内 · 杭州' })).json.territoryId).toBe(east.id);
    expect((await newAccount({ address: '国内 · 成都' })).json.territoryId).toBe(cn.id);
    // 同优先级按名称：“华东”与“国内IT”都是 10，名称排序“国内IT”在前 / ties by name
    expect((await newAccount({ address: '国内 · 常州', industry: 'IT' })).json.territoryId).toBe(it2.id);
    const none = (await newAccount({ address: '北美 · 芝加哥' })).json;
    expect(none).toMatchObject({ territoryId: null, territoryManual: false, territory: null });
    // 编辑地址后重新分配，审计记录区域变化 / edits reassign and are audited
    const moved = (await patchAccount(none.id, { address: '国内 · 杭州' })).json;
    expect(moved).toMatchObject({ territoryId: east.id, territory: { id: east.id, name: '华东' } });
    const log = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'account', action: 'account.update' } })).json.items[0];
    expect(log.changes.fields.territoryId).toEqual([null, east.id]);
    // 销售新建也自动分配，但不能手工指定 / sales are auto-assigned but cannot set territories
    expect((await newAccount({ address: '国内 · 西安' }, sales.token)).json.territoryId).toBe(cn.id);
    expect((await newAccount({ territoryId: cn.id }, sales.token)).json.error.details).toEqual({ territoryId: ['territory.manage required'] });
    expect((await newAccount({ territoryId: 'AUTO' }, sales.token)).status).toBe(403);
  });

  it('手工指定、无区域、恢复自动；重新分配不覆盖手工 / manual, none, AUTO and apply', async () => {
    const cn = (await newTerritory({ name: '国内', conditions: [addr('STARTS_WITH', '国内')] })).json;
    const eu = (await newTerritory({ name: '欧洲' })).json;
    const x = (await newAccount({ address: '国内 · 杭州', territoryId: eu.id }, mgr.token)).json;
    expect(x).toMatchObject({ territoryId: eu.id, territoryManual: true });
    expect((await patchAccount(x.id, { address: '国内 · 济南' })).json.territoryId).toBe(eu.id); // 手工不被覆盖 / manual sticks
    expect((await patchAccount(x.id, { territoryId: null })).json).toMatchObject({ territoryId: null, territoryManual: true });
    expect((await patchAccount(x.id, { territoryId: 'AUTO' })).json).toMatchObject({ territoryId: cn.id, territoryManual: false });
    const b = await createTenant('B');
    const foreign = (await newTerritory({ name: 'B区' }, b.token)).json;
    expect((await patchAccount(x.id, { territoryId: foreign.id })).json.error.details).toEqual({ territoryId: ['not_found'] });
    expect((await patchAccount(x.id, { territoryId: 'NONE' })).status).toBe(400);
    // 重新分配：改规则后对已有客户生效；手工指定的客户不变 / apply after a rule change; manual accounts stay
    const y = (await newAccount({ address: '欧洲 · 里昂' })).json;
    const z = (await newAccount({ address: '欧洲 · 哥德堡', territoryId: null })).json;
    expect(y.territoryId).toBeNull();
    await patchTerritory(eu.id, { conditions: [addr('STARTS_WITH', '欧洲')] });
    expect((await call(apply.POST, { token: mgr.token })).json).toEqual({ checked: 2, changed: 1 });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: y.id } })).territoryId).toBe(eu.id);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: z.id } })).territoryId).toBeNull();
    expect((await call(apply.POST, { token: a.token })).json).toEqual({ checked: 2, changed: 0 });
    const logs = (await call(auditLogs.GET, { token: a.token, query: { entityType: 'territory', action: 'territory.apply' } })).json.items as { changes: object }[];
    expect(logs.map((l) => l.changes)).toEqual([{ checked: 2, changed: 0 }, { checked: 2, changed: 1 }]);
  });
});

describe('territories R1 lists, imports and statistics', () => {
  it('筛选：含下级、无区域、我的区域；商机按客户区域；导出列 / filters and export', async () => {
    const cn = (await newTerritory({ name: '国内', conditions: [addr('STARTS_WITH', '国内')], priority: 50 })).json;
    const east = (await newTerritory({ name: '华东', parentId: cn.id, conditions: [addr('CONTAINS', '杭州')], priority: 10, memberIds: [mgr.user.id] })).json;
    const hz = (await newAccount({ name: '杭州客户', address: '国内 · 杭州' })).json;
    const cd = (await newAccount({ name: '成都客户', address: '国内 · 成都' })).json;
    await newAccount({ name: '海外客户', address: '北美' });
    expect(await names({ territoryId: cn.id })).toEqual(['成都客户', '杭州客户']);
    expect(await names({ territoryId: east.id })).toEqual(['杭州客户']);
    expect(await names({ territoryId: 'NONE' })).toEqual(['海外客户']);
    expect(await names({ territoryId: 'MINE' }, mgr.token)).toEqual(['杭州客户']);
    expect(await names({ territoryId: 'MINE' })).toEqual([]); // 管理员不是成员 / the admin is no member
    expect((await call(accounts.GET, { token: a.token, query: { territoryId: 'ALL' } })).status).toBe(400);
    const b = await createTenant('B');
    expect(await names({ territoryId: (await newTerritory({ name: 'B区' }, b.token)).json.id })).toEqual([]);
    for (const acc of [hz, cd]) await call(deals.POST, { token: a.token, body: { name: `${acc.name}商机`, accountId: acc.id, amount: '100', currency: 'CNY' } });
    const dealNames = async (territoryId: string) => ((await call(deals.GET, { token: a.token, query: { territoryId } })).json.items as { name: string }[]).map((d) => d.name).sort();
    expect(await dealNames(east.id)).toEqual(['杭州客户商机']);
    expect(await dealNames(cn.id)).toEqual(['成都客户商机', '杭州客户商机']);
    expect(await dealNames('NONE')).toEqual([]);
    const res = await accountExport.GET(new Request(`http://localhost/api/accounts/export?territoryId=${cn.id}`, { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    const [header, ...rows] = (await res.text()).replace(/^﻿/, '').trim().split('\r\n');
    expect(header!.endsWith(',区域')).toBe(true);
    expect(rows.map((r) => r.split(',').at(-1)).sort()).toEqual(['华东', '国内']);
  });

  it('导入、线索转化、回收站恢复都按区域处理 / import, conversion and restore', async () => {
    const cn = (await newTerritory({ name: '国内', conditions: [addr('STARTS_WITH', '国内')] })).json;
    const named = (await newTerritory({ name: '集团客户', priority: 5, conditions: [{ field: 'name', op: 'CONTAINS', value: '集团' }] })).json;
    const imp = await call(accountImport.POST, { token: a.token, body: { csv: '客户名称,地址\n导入甲,国内 · 杭州\n导入乙,北美', dryRun: false } });
    expect(imp.json.created).toBe(2);
    const imported = await prisma.account.findMany({ where: { name: { startsWith: '导入' } } });
    expect(Object.fromEntries(imported.map((x) => [x.name, x.territoryId]))).toEqual({ 导入甲: cn.id, 导入乙: null });
    // 线索转化新建的客户按规则分配 / converted accounts follow the rules
    const lead = (await call(leads.POST, { token: a.token, body: { name: '张三', company: '远望集团' } })).json;
    const conv = await call(convert.POST, { token: a.token, params: { id: lead.id }, body: { account: { mode: 'new' } } });
    expect(conv.status).toBe(200);
    expect((await prisma.account.findFirstOrThrow({ where: { name: '远望集团' } })).territoryId).toBe(named.id);
    // 回收站：区域仍在时保留；区域已删除时置空并恢复自动 / restore keeps an existing territory, clears a deleted one
    const eu = (await newTerritory({ name: '欧洲' })).json;
    const keep = (await newAccount({ name: '保留', territoryId: cn.id })).json;
    const gone = (await newAccount({ name: '清除', territoryId: eu.id })).json;
    for (const x of [keep, gone]) expect((await call(accountItem.DELETE, { token: a.token, params: { id: x.id }, method: 'DELETE' })).status).toBe(204);
    expect((await delTerritory(eu.id)).json).toEqual({ cleared: 0 });
    const items = (await call(bin.GET, { token: a.token })).json.items as { id: string; name: string }[];
    for (const it of items) expect((await call(restore.POST, { token: a.token, params: { id: it.id } })).status).toBe(200);
    expect(await prisma.account.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({ territoryId: cn.id, territoryManual: true });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: gone.id } })).toMatchObject({ territoryId: null, territoryManual: false });
  });

  it('统计：含下级、折合本币、缺少汇率提示、销售只统计自己的 / statistics', async () => {
    const cn = (await newTerritory({ name: '国内', conditions: [addr('STARTS_WITH', '国内')], priority: 50 })).json;
    const east = (await newTerritory({ name: '华东', parentId: cn.id, conditions: [addr('CONTAINS', '杭州')], priority: 10 })).json;
    await prisma.exchangeRate.create({ data: { organizationId: a.org.id, currency: 'USD', rate: '7.00000000', effectiveDate: new Date('2020-01-01') } });
    const hz = (await newAccount({ name: '杭州', address: '国内 · 杭州', ownerId: sales.user.id })).json;
    const cd = (await newAccount({ name: '成都', address: '国内 · 成都' })).json;
    const none = (await newAccount({ name: '无区域' })).json;
    const deal = (accountId: string, amount: string, currency: string, stage: string, ownerId = a.user.id) => call(deals.POST, { token: a.token, body: { name: 'D', accountId, amount, currency, stage, ownerId } });
    await deal(hz.id, '100.00', 'USD', 'PROPOSAL', sales.user.id);
    await deal(hz.id, '50.50', 'CNY', 'CLOSED_WON', sales.user.id);
    await deal(cd.id, '1000.00', 'CNY', 'NEGOTIATION');
    await deal(cd.id, '10.00', 'EUR', 'CLOSED_WON');
    await deal(cd.id, '999.00', 'CNY', 'CLOSED_LOST');
    await deal(none.id, '20.00', 'CNY', 'QUALIFICATION');
    const list = (await call(territories.GET, { token: a.token })).json;
    const byName = (n: string) => list.items.find((x: { name: string }) => x.name === n).stats;
    expect(byName('华东')).toEqual({ directAccounts: 1, accounts: 1, openCount: 1, openAmount: '700.00', wonCount: 1, wonAmount: '50.50', missingRates: [] });
    expect(byName('国内')).toEqual({ directAccounts: 1, accounts: 2, openCount: 2, openAmount: '1700.00', wonCount: 2, wonAmount: '50.50', missingRates: ['EUR'] });
    expect(list.unassigned).toEqual({ accounts: 1, openCount: 1, openAmount: '20.00', wonCount: 0, wonAmount: '0.00', missingRates: [] });
    expect(list.items.map((x: { name: string }) => x.name)).toEqual(['华东', '国内']); // 按优先级 / by priority
    expect(east.parentId).toBe(cn.id);
    // 销售只统计自己负责的客户与商机 / sales see only their own records
    const mine = (await call(territories.GET, { token: sales.token })).json;
    expect(mine.items.find((x: { name: string }) => x.name === '国内').stats).toEqual({ directAccounts: 0, accounts: 1, openCount: 1, openAmount: '700.00', wonCount: 1, wonAmount: '50.50', missingRates: [] });
    expect(mine.unassigned.accounts).toBe(0);
  });
});
