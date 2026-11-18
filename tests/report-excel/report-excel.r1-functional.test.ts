/**
 * 报表导出 Excel 第一轮：功能测试（写入器：ZIP 结构与 CRC、XML 转义与非法字符、公式样文本仍为文本、数字格式与加粗样式、冻结表头、
 * 工作表名清理去重截断、列号超过 Z、空单元格、输出稳定；销售报表 7 个工作表的数值与接口一致、中英文、文件名与响应头、
 * CSV 不变、格式参数校验、审计；销售预测的行与合计；应收账款三个工作表与报表一致；无导出权限 403）。
 * Report Excel export round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as forecastExport from '@/app/api/forecasts/export/route';
import * as forecasts from '@/app/api/forecasts/route';
import * as targets from '@/app/api/forecasts/targets/route';
import * as invoices from '@/app/api/invoices/route';
import * as leads from '@/app/api/leads/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as receivablesExport from '@/app/api/reports/receivables/export/route';
import * as receivables from '@/app/api/reports/receivables/route';
import * as salesExport from '@/app/api/reports/sales/export/route';
import * as sales from '@/app/api/reports/sales/route';
import * as orders from '@/app/api/sales-orders/route';
import { prisma } from '@/server/db';
import { toXlsx } from '@/server/xlsx';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { readXlsx } from './xlsx-reader';

type Route = { GET: (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response> };
let a: Awaited<ReturnType<typeof createTenant>>;
let seq = 0;
const month = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

/** 调用导出接口 / call an export route */
async function download(route: Route, path: string, query: Record<string, string>, token = a.token) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await route.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, book: res.status === 200 && query.format === 'xlsx' ? readXlsx(buf) : null };
}

/** 某工作表某行第 n 列的值 / value at row and column of a sheet */
function rowOf(sheet: { values: string[][] }, label: string): string[] {
  const row = sheet.values.find((r) => r[0] === label);
  expect(row, label).toBeDefined();
  return row!;
}

/** 造数：客户、各阶段商机、线索 / seed deals and leads */
async function seedSales() {
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '报表客户' } })).json;
  for (const [name, amount, stage] of [['赢单一', '1000.50', 'CLOSED_WON'], ['输单一', '300', 'CLOSED_LOST'], ['谈判中', '2000', 'NEGOTIATION'], ['需求分析', '500', 'NEEDS_ANALYSIS']]) {
    expect((await call(deals.POST, { token: a.token, body: { name, accountId: acc.id, amount, stage, expectedCloseDate: today } })).status).toBe(201);
  }
  for (const source of ['WEBSITE', 'WEBSITE', 'REFERRAL']) await call(leads.POST, { token: a.token, body: { name: `线索${source}`, source } });
}

/** 建一张发票（单价 100 × 数量）/ create an invoice (100 × quantity) */
async function invoice(accountName: string, quantity: string, dueIn: number) {
  seq += 1;
  const p = (await call(products.POST, { token: a.token, body: { sku: `P-${seq}`, name: '产品', unitPrice: '100' } })).json;
  const acc = (await call(accounts.POST, { token: a.token, body: { name: accountName } })).json;
  const d = (await call(deals.POST, { token: a.token, body: { name: `商机${seq}`, accountId: acc.id } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: d.id }, body: { productId: p.id, quantity } });
  const q = (await call(quotes.POST, { token: a.token, body: { dealId: d.id } })).json;
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token: a.token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  const o = (await call(orders.POST, { token: a.token, body: { quoteId: q.id } })).json;
  const inv = await call(invoices.POST, { token: a.token, body: { salesOrderId: o.id, invoiceDate: ymd(Math.min(dueIn, 0) - 30), dueDate: ymd(dueIn) } });
  expect(inv.status).toBe(201);
  return inv.json;
}

beforeEach(async () => {
  await resetDb();
  seq = 0;
  a = await createTenant('A');
});

describe('report excel R1 writer', () => {
  it('ZIP 结构、转义、公式样文本、数字格式、加粗、冻结、工作表名、列号、空单元格、输出稳定 / writer basics', () => {
    const sheets = [
      {
        name: '概览/汇总?',
        rows: [['标题'], ['名称', '金额', '比率', '数量'], ['<b>&"x"', { value: 1234.5, format: 'money' as const }, { value: 45.5, format: 'percent' as const }, { value: 7, format: 'int' as const }], ['=SUM(A1:A2)', null, '', 0], ['ctl\u0001\u0008\u000Bok']],
        boldRows: [0, 1],
        freezeRows: 2,
      },
      { name: '概览 汇总', rows: [Array.from({ length: 28 }, (_, i) => i)] },
      { name: 'x'.repeat(40), rows: [[{ value: 'b', bold: true }]] },
    ];
    const buf = toXlsx(sheets);
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(toXlsx(sheets).equals(buf)).toBe(true);
    const book = readXlsx(buf);
    expect([...book.files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']);
    // 工作表名：非法字符替换、去重、截断到 31 / sheet names: illegal characters replaced, deduplicated, max 31
    expect(book.names).toEqual(['概览 汇总', '概览 汇总 2', 'x'.repeat(31)]);
    const [s1, s2, s3] = book.sheets;
    expect(s1!.values).toEqual([['标题'], ['名称', '金额', '比率', '数量'], ['<b>&"x"', '1234.5', '45.5', '7'], ['=SUM(A1:A2)', '0'], ['ctlok']]);
    // 文本一律为内联字符串，没有公式 / text is always an inline string, never a formula
    expect(s1!.xml).not.toContain('<f>');
    expect(s1!.rows[3]!.cells[0]).toMatchObject({ type: 'inlineStr', value: '=SUM(A1:A2)' });
    // 样式：表头加粗（1），金额 2，比率 4，整数 3 / styles
    expect(s1!.rows[1]!.cells.map((c) => c.style)).toEqual([1, 1, 1, 1]);
    expect(s1!.rows[2]!.cells.map((c) => c.style)).toEqual([0, 2, 4, 3]);
    expect(s1!.xml).toContain('<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>');
    expect(s2!.rows[0]!.cells.map((c) => c.ref).slice(-3)).toEqual(['Z1', 'AA1', 'AB1']);
    expect(s3!.rows[0]!.cells[0]).toMatchObject({ style: 1, value: 'b' });
    // 百分比格式显示 %，金额千分位 / percent format shows %, money uses separators
    const styles = book.files.get('xl/styles.xml')!.toString();
    expect(styles).toContain('formatCode="0.0&quot;%&quot;"');
    expect(() => toXlsx([])).toThrow();
  });
});

describe('report excel R1 sales and forecast', () => {
  it('销售报表：7 个工作表、数值与接口一致、中英文、响应头、审计；CSV 不变 / sales report', async () => {
    await seedSales();
    const json = (await call(sales.GET, { token: a.token, query: { currency: 'CNY' } })).json;
    const { res, book } = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'xlsx' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="sales-report-CNY-\d{8}-\d{8}\.xlsx"$/);
    expect(Number(res.headers.get('x-export-count'))).toBeGreaterThan(10);
    expect(book!.names).toEqual(['概览', '销售漏斗（进行中商机）', '按月赢单', '负责人排行', '线索来源转化', '报价单状态', '竞争对手胜负']);
    const summary = book!.sheets[0]!;
    expect(summary.values.slice(0, 2)).toEqual([['销售报表'], ['币种', 'CNY']]);
    expect(Number(rowOf(summary, '期间赢单金额')[1])).toBe(Number(json.summary.wonAmount));
    expect(Number(rowOf(summary, '期间赢单金额')[1])).toBe(1000.5);
    expect(rowOf(summary, '赢单率 %')[1]).toBe(String(json.summary.winRate));
    // 金额单元格为数字并使用金额格式 / amount cells are numbers in money format
    const wonCell = summary.rows.find((r) => r.cells[0]?.value === '期间赢单金额')!.cells[1]!;
    expect(wonCell).toMatchObject({ type: null, style: 2 });
    // 漏斗与接口一致 / funnel matches the API
    const funnel = book!.sheets[1]!;
    expect(funnel.values[0]).toEqual(['阶段', '数量', '金额']);
    for (const f of json.funnel as { count: number; amount: string }[]) expect(funnel.values.some((r) => r[1] === String(f.count) && Number(r[2]) === Number(f.amount))).toBe(true);
    expect(funnel.xml).toContain('<pane ySplit="1"');
    // 英文 / English
    const en = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'xlsx', lang: 'en-US' });
    expect(en.book!.names[0]).toBe('Summary');
    // CSV 不变；format=csv 等同默认；非法格式 400 / CSV unchanged; format=csv equals default; invalid format 400
    const csv1 = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY' });
    const csv2 = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'csv' });
    expect(csv1.res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv1.buf.toString()).toBe(csv2.buf.toString());
    expect((await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'pdf' })).res.status).toBe(400);
    // 审计：Excel 记录格式，CSV 不记 / audit: Excel records the format, CSV does not
    const logs = await prisma.auditLog.findMany({ where: { action: 'report.export' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => (l.changes as { filters: { format?: string } }).filters.format ?? 'csv')).toEqual(['xlsx', 'xlsx', 'csv', 'csv']);
  });

  it('销售预测：每个负责人一行，合计行加粗，数值与接口一致 / forecast', async () => {
    await seedSales();
    await call(targets.PUT, { token: a.token, body: { userId: a.user.id, month, currency: 'CNY', amount: '5000' }, method: 'PUT' });
    const json = (await call(forecasts.GET, { token: a.token, query: { period: month, currency: 'CNY' } })).json;
    const { res, book } = await download(forecastExport, '/api/forecasts/export', { period: month, currency: 'CNY', format: 'xlsx' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="forecast-CNY-${month}.xlsx"`);
    const sheet = book!.sheets[0]!;
    expect(sheet.values.slice(0, 3)).toEqual([['销售目标与预测'], ['期间', month], ['币种', 'CNY']]);
    const header = sheet.values[4]!;
    expect(header[0]).toBe('负责人');
    expect(sheet.xml).toContain('<pane ySplit="5"');
    const owner = rowOf(sheet, json.rows[0].name);
    expect(Number(owner[1])).toBe(Number(json.rows[0].target));
    expect(Number(owner[2])).toBe(Number(json.rows[0].won));
    const totalRow = sheet.rows.find((r) => r.cells[0]?.value === '团队合计')!;
    expect(totalRow.cells.every((c) => [1, 5, 6, 7].includes(c.style))).toBe(true);
    expect(Number(totalRow.cells[2]!.value)).toBe(Number(json.totals.won));
  });
});

describe('report excel R1 receivables', () => {
  it('应收账款：汇总、按客户、明细三个工作表与报表一致；无导出权限 403 / receivables', async () => {
    await invoice('甲客户', '3', -40);
    await invoice('乙客户', '2', 10);
    await invoice('甲客户', '1', -5);
    const json = (await call(receivables.GET, { token: a.token, query: { currency: 'CNY' } })).json;
    const { res, book } = await download(receivablesExport, '/api/reports/receivables/export', { currency: 'CNY', format: 'xlsx' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-count')).toBe('3');
    expect(book!.names).toEqual(['概览', '按客户汇总', '未收发票']);
    const [summary, byAccount, detail] = book!.sheets;
    expect(Number(rowOf(summary!, '未收金额')[1])).toBe(Number(json.summary.outstanding));
    expect(Number(rowOf(summary!, '逾期金额')[1])).toBe(Number(json.summary.overdue));
    expect(rowOf(summary!, '逾期金额')[2]).toBe(String(json.summary.overdueCount));
    for (const b of json.buckets as { bucket: string; amount: string; count: number }[]) {
      const label = { current: '未到期', d1_30: '逾期 1–30 天', d31_60: '逾期 31–60 天', d61_90: '逾期 61–90 天', d90_plus: '逾期 90 天以上' }[b.bucket]!;
      const row = rowOf(summary!, label);
      expect(Number(row[1] ?? 0)).toBe(Number(b.amount));
    }
    expect(byAccount!.values.slice(1).map((r) => r[0])).toEqual(json.accounts.map((x: { name: string }) => x.name));
    expect(detail!.values).toHaveLength(4);
    expect(detail!.values.slice(1).map((r) => Number(r[7]))).toEqual(json.invoices.map((i: { balance: string }) => Number(i.balance)));
    // 审计记录格式 / audited with the format
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'invoice.export' } })).changes).toMatchObject({ report: 'receivables', format: 'xlsx', count: 3 });
    // 销售代表、只读用户没有导出权限 / sales reps and read-only users cannot export
    for (const role of ['SALES', 'READONLY'] as const) {
      const u = await addUser(a.org.id, role);
      expect((await download(receivablesExport, '/api/reports/receivables/export', { currency: 'CNY', format: 'xlsx' }, u.token)).res.status).toBe(403);
      expect((await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'xlsx' }, u.token)).res.status).toBe(403);
    }
  });
});
