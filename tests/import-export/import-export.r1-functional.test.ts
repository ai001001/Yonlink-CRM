/**
 * 导入导出 第一轮：功能测试（CSV 解析/生成、四个模块导出、线索与客户导入、预检、查重、模板）。
 * Import / export round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountExport from '@/app/api/accounts/export/route';
import * as accountImport from '@/app/api/accounts/import/route';
import * as accountTemplate from '@/app/api/accounts/import/template/route';
import * as activities from '@/app/api/activities/route';
import * as activityExport from '@/app/api/activities/export/route';
import * as deals from '@/app/api/deals/route';
import * as dealExport from '@/app/api/deals/export/route';
import * as leads from '@/app/api/leads/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leadTemplate from '@/app/api/leads/import/template/route';
import { csvCell, parseCsv, toCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

/** 调用返回 CSV 的路由 / call a route returning CSV */
async function getCsv(handler: (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response>, query: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/x');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await handler(new Request(url, { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
  const text = await res.text();
  return { status: res.status, text, rows: res.ok ? parseCsv(text) : [], headers: res.headers };
}

async function post(handler: typeof leads.POST, body: unknown) {
  const res = await handler(
    new Request('http://localhost/api/x', { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, json: await res.json() };
}

describe('CSV read/write', () => {
  it('解析引号、转义引号、字段内换行、CRLF、BOM 与空行 / parses quotes, escapes, newlines, CRLF, BOM', () => {
    const text = '﻿姓名,备注\r\n"张, 三","他说""你好"""\r\n李四,"第一行\n第二行"\r\n\r\n';
    expect(parseCsv(text)).toEqual([['姓名', '备注'], ['张, 三', '他说"你好"'], ['李四', '第一行\n第二行']]);
  });

  it('未闭合引号报错 / unterminated quotes throw', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow();
  });

  it('生成：BOM + CRLF，需要时加引号，往返一致 / writes BOM + CRLF and round-trips', () => {
    const csv = toCsv(['甲', '乙'], [['a,b', 'x"y'], ['多\n行', null]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(parseCsv(csv)).toEqual([['甲', '乙'], ['a,b', 'x"y'], ['多\n行', '']]);
  });

  it('防公式注入 / neutralises formula injection', () => {
    for (const v of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x']) expect(csvCell(v).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    expect(csvCell('普通文本')).toBe('普通文本');
    expect(csvCell(42)).toBe('42');
  });
});

describe('export', () => {
  it('导出线索：中文表头、枚举翻译、负责人邮箱、北京时间 / leads export', async () => {
    await post(leads.POST, { name: '张三', company: '星河', email: 'zs@example.com', source: 'EXHIBITION', status: 'CONTACTED' });
    const r = await getCsv(leadExport.GET);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="leads-\d{8}\.csv"/);
    expect(r.headers.get('x-export-count')).toBe('1');
    expect(r.rows[0]).toEqual(['姓名', '公司', '职位', '电话', '手机', '邮箱', '线索来源', '线索状态', '负责人', '负责人邮箱', '创建时间（UTC+8）', '备注']);
    expect(r.rows[1]!.slice(0, 10)).toEqual(['张三', '星河', '', '', '', 'zs@example.com', '展会', '已联系', a.user.name, a.user.email]);
    expect(r.rows[1]![10]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('导出遵循列表筛选与搜索 / export follows list filters and search', async () => {
    await post(leads.POST, { name: '甲', status: 'NEW' });
    await post(leads.POST, { name: '乙', status: 'QUALIFIED' });
    await post(leads.POST, { name: '丙关键字', status: 'QUALIFIED' });
    expect((await getCsv(leadExport.GET, { status: 'QUALIFIED' })).rows.slice(1).map((r) => r[0]).sort()).toEqual(['丙关键字', '乙']);
    expect((await getCsv(leadExport.GET, { q: '关键字' })).rows.slice(1).map((r) => r[0])).toEqual(['丙关键字']);
  });

  it('导出客户、商机、跟进 / accounts, deals and activities export', async () => {
    const acc = (await post(accounts.POST, { name: '远望制造', industry: 'MANUFACTURING' })).json;
    await post(deals.POST, { name: '年度采购', accountId: acc.id, amount: '1234.5', stage: 'PROPOSAL', expectedCloseDate: '2027-03-31' });
    await post(activities.POST, { type: 'CALL', subject: '电话', accountId: acc.id, completed: true });
    expect((await getCsv(accountExport.GET)).rows[1]!.slice(0, 2)).toEqual(['远望制造', '制造业']);
    const d = (await getCsv(dealExport.GET)).rows[1]!;
    expect(d.slice(0, 6)).toEqual(['年度采购', '远望制造', '1234.50', 'CNY', '方案报价', '2027-03-31']);
    const act = (await getCsv(activityExport.GET)).rows[1]!;
    expect([act[0], act[1], act[4], act[5]]).toEqual(['电话', '电话', '已完成', '远望制造']);
  });

  it('导出写审计（记录数量与筛选，不记搜索词）/ exports are audited without the search text', async () => {
    await post(leads.POST, { name: '机密客户名' });
    await getCsv(leadExport.GET, { q: '机密客户名', status: 'NEW' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.export' } });
    expect(log.changes).toEqual({ count: 1, truncated: false, searched: true, filters: { status: 'NEW' } });
    expect(JSON.stringify(log)).not.toContain('机密客户名');
  });
});

describe('import', () => {
  const leadCsv = ['姓名,公司,邮箱,线索来源,线索状态,负责人邮箱,备注', '王五,甲公司,ww@example.com,展会,已联系,,来自展会', '赵六,乙公司,zl@example.com,WEBSITE,,,'].join('\n');

  it('预检不写入，返回可导入数量 / dry run writes nothing', async () => {
    const r = await post(leadImport.POST, { csv: leadCsv, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: true, total: 2, valid: 2, created: 0, errors: [], duplicates: [], unknownColumns: [] });
    expect(await prisma.lead.count()).toBe(0);
  });

  it('导入线索：中文标签与代码都可识别，负责人默认自己，逐条审计 / imports leads', async () => {
    const r = await post(leadImport.POST, { csv: leadCsv, dryRun: false });
    expect(r.json.created).toBe(2);
    const rows = await prisma.lead.findMany({ orderBy: { name: 'asc' } });
    expect(rows.map((l) => [l.name, l.source, l.status, l.ownerId])).toEqual([
      ['王五', 'EXHIBITION', 'CONTACTED', a.user.id],
      ['赵六', 'WEBSITE', 'NEW', a.user.id],
    ]);
    expect(await prisma.auditLog.count({ where: { action: 'lead.create' } })).toBe(2);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.import' } })).changes).toMatchObject({ total: 2, created: 2 });
  });

  it('英文字段名表头也可导入，未知列被忽略并提示 / English headers work, unknown columns are reported', async () => {
    const r = await post(leadImport.POST, { csv: 'name,email,备用列\n钱七,qq@example.com,x', dryRun: false });
    expect(r.json).toMatchObject({ created: 1, unknownColumns: ['备用列'] });
  });

  it('查重：与已有记录或文件内重复的默认跳过，可选择仍然创建 / duplicates skipped by default, optionally created', async () => {
    await post(leads.POST, { name: '已存在', email: 'ww@example.com' });
    const csv = '姓名,邮箱\n王五,WW@example.com\n孙八,sb@example.com\n孙八二,sb@example.com';
    const skip = await post(leadImport.POST, { csv, dryRun: false });
    expect(skip.json).toMatchObject({ created: 1, duplicates: [{ row: 2 }, { row: 4 }] });
    const create = await post(leadImport.POST, { csv: '姓名,邮箱\n王五,ww@example.com', dryRun: false, duplicates: 'create' });
    expect(create.json.created).toBe(1);
    expect(await prisma.lead.count({ where: { email: 'ww@example.com' } })).toBe(2);
  });

  it('导入客户并创建主要联系人 / imports accounts with a primary contact', async () => {
    const csv = '客户名称,行业,电话,联系人姓名,联系人职位,联系人邮箱\n远望制造,制造业,0571-1,陈经理,采购总监,chen@example.com\n清风科技,,,,,';
    const r = await post(accountImport.POST, { csv, dryRun: false });
    expect(r.json.created).toBe(2);
    const acc = await prisma.account.findFirstOrThrow({ where: { name: '远望制造' }, include: { contacts: true } });
    expect(acc.industry).toBe('MANUFACTURING');
    expect(acc.contacts.map((c) => [c.name, c.title, c.isPrimary])).toEqual([['陈经理', '采购总监', true]]);
    expect(await prisma.contact.count()).toBe(1);
  });

  it('导入后再导出，数据一致（往返）/ import then export round-trips', async () => {
    await post(leadImport.POST, { csv: leadCsv, dryRun: false });
    const out = await getCsv(leadExport.GET);
    const reimport = await post(leadImport.POST, { csv: toCsv(out.rows[0]!, out.rows.slice(1)), dryRun: true, duplicates: 'create' });
    expect(reimport.json).toMatchObject({ total: 2, valid: 2, errors: [] });
  });

  it('模板：表头可被导入识别（含示例行）/ templates are importable', async () => {
    for (const [tpl, imp] of [
      [leadTemplate.GET, leadImport.POST],
      [accountTemplate.GET, accountImport.POST],
    ] as const) {
      const t = await getCsv(tpl as typeof leadExport.GET);
      expect(t.status).toBe(200);
      expect(t.rows).toHaveLength(2);
      const r = await post(imp, { csv: t.text, dryRun: true });
      expect(r.json).toMatchObject({ total: 1, valid: 1, errors: [], unknownColumns: [] });
    }
  });
});
