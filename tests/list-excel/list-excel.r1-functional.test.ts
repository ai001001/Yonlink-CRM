/**
 * 列表导出 Excel 第一轮：功能测试（线索、客户、联系人、商机、跟进、工单 6 个列表：Excel 的表头、行数、各单元格与同一筛选下的
 * CSV 完全一致；金额、数量为数字单元格；工作表名随语言；文件名与响应头；筛选生效；审计记录格式而 CSV 不记；非法格式 400；
 * 无导出权限 403）。
 * List Excel export round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountExport from '@/app/api/accounts/export/route';
import * as accounts from '@/app/api/accounts/route';
import * as activityExport from '@/app/api/activities/export/route';
import * as activities from '@/app/api/activities/route';
import * as contactExport from '@/app/api/contacts/export/route';
import * as dealExport from '@/app/api/deals/export/route';
import * as deals from '@/app/api/deals/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leads from '@/app/api/leads/route';
import * as ticketExport from '@/app/api/tickets/export/route';
import * as tickets from '@/app/api/tickets/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { readXlsx } from '../report-excel/xlsx-reader';

type Route = { GET: (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response> };
let a: Awaited<ReturnType<typeof createTenant>>;
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** 调用导出接口 / call an export route */
async function download(route: Route, path: string, query: Record<string, string> = {}, token = a.token) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await route.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

/** 造数：每个列表至少两条，每步断言成功 / seed at least two rows for every list, asserting each step */
async function seed() {
  const ok = async (r: Promise<{ status: number; json: { id: string } }>, label: string) => {
    const res = await r;
    expect(res.status, `${label}: ${JSON.stringify(res.json)}`).toBe(201);
    return res.json;
  };
  const acc1 = await ok(call(accounts.POST, { token: a.token, body: { name: '甲客户', industry: 'MANUFACTURING', phone: '021-1' } }), 'account 1');
  const acc2 = await ok(call(accounts.POST, { token: a.token, body: { name: '乙客户 <&>' } }), 'account 2');
  for (const [acc, name, mail] of [[acc1, '张三', 'zhang'], [acc1, '李四', 'li'], [acc2, '王五', 'wang']] as const) await ok(call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name, email: `${mail}@example.com` } }), `contact ${name}`);
  await ok(call(leads.POST, { token: a.token, body: { name: '线索一', company: '公司 A', source: 'WEBSITE', status: 'NEW' } }), 'lead 1');
  await ok(call(leads.POST, { token: a.token, body: { name: '=线索二', source: 'REFERRAL', status: 'CONTACTED', description: '多行\n说明' } }), 'lead 2');
  await ok(call(deals.POST, { token: a.token, body: { name: '商机一', accountId: acc1.id, amount: '12345.6', stage: 'PROPOSAL' } }), 'deal 1');
  await ok(call(deals.POST, { token: a.token, body: { name: '商机二', accountId: acc2.id, amount: '0', stage: 'QUALIFICATION' } }), 'deal 2');
  await ok(call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '电话回访', accountId: acc1.id } }), 'activity 1');
  await ok(call(activities.POST, { token: a.token, body: { type: 'VISIT', subject: '上门拜访', accountId: acc2.id, completed: true } }), 'activity 2');
  await ok(call(tickets.POST, { token: a.token, body: { subject: '工单一', accountId: acc1.id } }), 'ticket 1');
  await ok(call(tickets.POST, { token: a.token, body: { subject: '工单二', accountId: acc2.id, priority: 'URGENT' } }), 'ticket 2');
}

const LISTS: { name: string; route: Route; path: string; sheet: string; en: string; numeric: Record<number, number> }[] = [
  { name: 'leads', route: leadExport, path: '/api/leads/export', sheet: '线索', en: 'Leads', numeric: {} },
  { name: 'accounts', route: accountExport, path: '/api/accounts/export', sheet: '客户', en: 'Accounts', numeric: { 8: 3 } },
  { name: 'contacts', route: contactExport, path: '/api/contacts/export', sheet: '联系人', en: 'Contacts', numeric: {} },
  { name: 'deals', route: dealExport, path: '/api/deals/export', sheet: '商机', en: 'Deals', numeric: { 2: 2 } },
  { name: 'activities', route: activityExport, path: '/api/activities/export', sheet: '跟进', en: 'Activities', numeric: {} },
  { name: 'tickets', route: ticketExport, path: '/api/tickets/export', sheet: '服务工单', en: 'Service tickets', numeric: { 15: 3 } },
];

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('list excel R1', () => {
  it('6 个列表：Excel 与 CSV 内容一致，数字列为数字单元格，工作表名随语言 / Excel matches CSV for all six lists', async () => {
    await seed();
    for (const list of LISTS) {
      const csv = await download(list.route, list.path);
      const xlsx = await download(list.route, list.path, { format: 'xlsx' });
      expect(xlsx.res.status, list.name).toBe(200);
      expect(xlsx.res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(xlsx.res.headers.get('content-disposition')).toBe(`attachment; filename="${list.name}-${stamp}.xlsx"`);
      expect(xlsx.res.headers.get('x-export-count')).toBe(csv.res.headers.get('x-export-count'));
      const csvRows = parseCsv(csv.buf.toString('utf8'));
      const book = readXlsx(xlsx.buf);
      expect(book.names, list.name).toEqual([list.sheet]);
      const sheet = book.sheets[0]!;
      expect(sheet.xml).toContain('<pane ySplit="1"');
      // 表头加粗且与 CSV 相同 / bold header identical to the CSV
      expect(sheet.rows[0]!.cells.map((c) => c.value)).toEqual(csvRows[0]);
      expect(sheet.rows[0]!.cells.every((c) => c.style === 1)).toBe(true);
      expect(sheet.rows).toHaveLength(csvRows.length);
      expect(sheet.rows.length, list.name).toBeGreaterThanOrEqual(3);
      // 逐个单元格比较（CSV 中防公式注入的单引号前缀除外；数字列按数值比较）
      // cell by cell (except the CSV's formula-guard quote prefix; numeric columns compared as numbers)
      for (let r = 1; r < csvRows.length; r += 1) {
        const byCol = new Map(sheet.rows[r]!.cells.map((c) => [c.ref.replace(/\d+$/, ''), c]));
        csvRows[r]!.forEach((value, i) => {
          const col = String.fromCharCode(65 + i);
          const cell = byCol.get(col);
          if (value === '') return expect(cell, `${list.name} ${col}${r + 1}`).toBeUndefined();
          if (list.numeric[i] !== undefined) {
            expect(cell!.type, `${list.name} ${col}`).toBeNull();
            expect(cell!.style).toBe(list.numeric[i]);
            return expect(Number(cell!.value)).toBe(Number(value));
          }
          expect(cell!.value, `${list.name} ${col}${r + 1}`).toBe(value.startsWith("'=") ? value.slice(1) : value);
        });
      }
      // 英文工作表名 / English sheet name
      const en = await download(list.route, list.path, { format: 'xlsx', lang: 'en-US' });
      expect(readXlsx(en.buf).names).toEqual([list.en]);
    }
    // 公式样文本在 Excel 中仍为文本 / formula-like text stays text in Excel
    const leadBook = readXlsx((await download(leadExport, '/api/leads/export', { format: 'xlsx' })).buf);
    expect(leadBook.sheets[0]!.xml).not.toContain('<f>');
    expect(leadBook.sheets[0]!.values.map((r) => r[0])).toContain('=线索二');
  });

  it('筛选生效；审计记录格式；非法格式 400；无导出权限 403 / filters, audit, validation, permissions', async () => {
    await seed();
    const filtered = readXlsx((await download(leadExport, '/api/leads/export', { format: 'xlsx', status: 'CONTACTED' })).buf);
    expect(filtered.sheets[0]!.values.slice(1).map((r) => r[0])).toEqual(['=线索二']);
    const won = readXlsx((await download(dealExport, '/api/deals/export', { format: 'xlsx', stage: 'PROPOSAL' })).buf);
    expect(won.sheets[0]!.values.slice(1).map((r) => r[0])).toEqual(['商机一']);
    expect(Number(won.sheets[0]!.values[1]![2])).toBe(12345.6);
    // 审计：Excel 记录格式与筛选，CSV 不记格式 / audit: Excel records the format and filters, CSV does not
    await download(leadExport, '/api/leads/export');
    const logs = await prisma.auditLog.findMany({ where: { action: 'lead.export' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => (l.changes as { filters: Record<string, string> }).filters)).toEqual([{ format: 'xlsx', status: 'CONTACTED' }, {}]);
    expect((await download(leadExport, '/api/leads/export', { format: 'docx' })).res.status).toBe(400);
    for (const role of ['SALES', 'READONLY'] as const) {
      const u = await addUser(a.org.id, role);
      for (const list of LISTS) expect((await download(list.route, list.path, { format: 'xlsx' }, u.token)).res.status, `${role} ${list.name}`).toBe(403);
    }
  });
});
