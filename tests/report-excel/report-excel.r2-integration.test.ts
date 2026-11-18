/**
 * 报表导出 Excel 第二轮：集成测试（用 Python 标准库 zipfile 与 XML 解析器独立校验真实导出文件，并核对包内关系与内容类型；
 * 跨组织隔离；客户名含公式样文本、XML 特殊字符、表情与中日韩字符时仍为文本且原样保留；明细截断时汇总仍为全量；
 * 并发导出结果一致；2 万行工作表的生成耗时；跨域时可读取文件名与导出条数响应头）。
 * Report Excel export round 2: integration tests.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as deals from '@/app/api/deals/route';
import * as invoices from '@/app/api/invoices/route';
import * as products from '@/app/api/products/route';
import * as quoteStatus from '@/app/api/quotes/[id]/status/route';
import * as quotes from '@/app/api/quotes/route';
import * as receivablesExport from '@/app/api/reports/receivables/export/route';
import * as salesExport from '@/app/api/reports/sales/export/route';
import * as orders from '@/app/api/sales-orders/route';
import { exportReceivablesXlsx } from '@/server/modules/report-xlsx';
import { toXlsx } from '@/server/xlsx';
import { call, createTenant, resetDb } from '../helpers';
import { readXlsx } from './xlsx-reader';

type Route = { GET: (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response> };
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
let seq = 0;
const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 调用导出接口 / call an export route */
async function download(route: Route, path: string, query: Record<string, string>, token: string, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await route.GET(new Request(url, { headers: { authorization: `Bearer ${token}`, ...headers } }), { params: Promise.resolve({}) });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

/**
 * 用 Python 标准库独立校验：ZIP 每个文件的 CRC、每个 XML 是否格式良好、内容类型与关系是否指向存在的部件。
 * Validate independently with Python's standard library: every ZIP CRC, every XML well-formed, content types and
 * relationships pointing at existing parts.
 */
function pythonCheck(buf: Buffer): { sheets: string[]; parts: number } {
  const file = join(dir, `f${++seq}.xlsx`);
  writeFileSync(file, buf);
  const script = `
import json, sys, zipfile, xml.dom.minidom as m
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None, 'crc'
names = set(z.namelist())
for n in names: m.parseString(z.read(n))
ct = m.parseString(z.read('[Content_Types].xml'))
for o in ct.getElementsByTagName('Override'): assert o.getAttribute('PartName').lstrip('/') in names, o.getAttribute('PartName')
rels = m.parseString(z.read('xl/_rels/workbook.xml.rels'))
targets = {r.getAttribute('Id'): 'xl/' + r.getAttribute('Target') for r in rels.getElementsByTagName('Relationship')}
for t in targets.values(): assert t in names, t
wb = m.parseString(z.read('xl/workbook.xml'))
sheets = [s.getAttribute('name') for s in wb.getElementsByTagName('sheet')]
for s in wb.getElementsByTagName('sheet'): assert targets[s.getAttribute('r:id')] in names
print(json.dumps({'sheets': sheets, 'parts': len(names)}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, file]).toString());
}

/** 建一张发票（单价 100 × 数量）/ create an invoice (100 × quantity) */
async function invoice(token: string, accountName: string, quantity: string, dueIn: number) {
  seq += 1;
  const p = (await call(products.POST, { token, body: { sku: `P-${seq}`, name: '产品', unitPrice: '100' } })).json;
  const acc = (await call(accounts.POST, { token, body: { name: accountName } })).json;
  const d = (await call(deals.POST, { token, body: { name: `商机${seq}`, accountId: acc.id } })).json;
  await call(dealItems.POST, { token, params: { id: d.id }, body: { productId: p.id, quantity } });
  const q = (await call(quotes.POST, { token, body: { dealId: d.id } })).json;
  await call(quoteStatus.POST, { token, params: { id: q.id }, body: { status: 'SENT' } });
  await call(quoteStatus.POST, { token, params: { id: q.id }, body: { status: 'ACCEPTED' } });
  const o = (await call(orders.POST, { token, body: { quoteId: q.id } })).json;
  const inv = await call(invoices.POST, { token, body: { salesOrderId: o.id, invoiceDate: ymd(Math.min(dueIn, 0) - 30), dueDate: ymd(dueIn) } });
  expect(inv.status).toBe(201);
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

describe('report excel R2 validity & content safety', () => {
  it('Python 独立校验；危险文本仍为文本；跨组织隔离 / independent validation, text safety, isolation', async () => {
    const names = ['=HYPERLINK("http://evil.example","点我")', '<script>alert(1)</script> & "引号"', '涡轮客户 🚀 東京'];
    for (const [i, n] of names.entries()) await invoice(a.token, n, String(i + 1), -10 * i);
    const { res, buf } = await download(receivablesExport, '/api/reports/receivables/export', { currency: 'CNY', format: 'xlsx' }, a.token);
    expect(res.status).toBe(200);
    expect(pythonCheck(buf)).toEqual({ sheets: ['概览', '按客户汇总', '未收发票'], parts: 8 });
    const book = readXlsx(buf);
    const detail = book.sheets[2]!;
    expect(detail.values.slice(1).map((r) => r[1]).sort()).toEqual([...names].sort());
    expect(detail.xml).not.toContain('<f>');
    expect(detail.xml).not.toContain('<script>');
    // 销售报表也通过独立校验 / the sales report passes as well
    const sales = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'xlsx' }, a.token);
    expect(pythonCheck(sales.buf).sheets).toHaveLength(7);
    // B 组织的导出不含 A 的数据 / B's export contains none of A's data
    const other = await download(receivablesExport, '/api/reports/receivables/export', { currency: 'CNY', format: 'xlsx' }, b.token);
    expect(other.res.headers.get('x-export-count')).toBe('0');
    const otherBook = readXlsx(other.buf);
    expect(otherBook.sheets[2]!.values).toHaveLength(1);
    for (const n of names) expect(other.buf.includes(Buffer.from(n))).toBe(false);
  });

  it('明细截断时汇总仍为全量；并发导出结果一致 / truncation and determinism', async () => {
    for (let i = 0; i < 3; i += 1) await invoice(a.token, `客户${i}`, '1', -i);
    const ctx = { userId: a.user.id, organizationId: a.org.id, role: 'ADMIN' as const, meta: {} };
    const r = await exportReceivablesXlsx(ctx as never, { currency: 'CNY' }, new Date(), 2);
    expect(r).toMatchObject({ count: 2, truncated: true });
    const book = readXlsx(r.data);
    expect(book.sheets[2]!.values).toHaveLength(3);
    const outstanding = book.sheets[0]!.values.find((row) => row[0] === '未收金额')!;
    expect(outstanding.slice(1)).toEqual(['300', '3']);
    // 同一时刻并发导出，文件内容一致 / concurrent exports yield identical bytes
    const now = new Date();
    const files = await Promise.all(Array.from({ length: 5 }, () => exportReceivablesXlsx(ctx as never, { currency: 'CNY' }, now)));
    expect(files.every((f) => f.data.equals(files[0]!.data))).toBe(true);
  });

  it('2 万行工作表的生成耗时与有效性 / 20,000 rows', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => [`客户${i}`, { value: i * 1.25, format: 'money' as const }, { value: i % 100, format: 'percent' as const }]);
    const started = Date.now();
    const buf = toXlsx([{ name: '明细', rows: [['名称', '金额', '比率'], ...rows], boldRows: [0], freezeRows: 1 }]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pythonCheck(buf)).toEqual({ sheets: ['明细'], parts: 6 });
    expect(readXlsx(buf).sheets[0]!.values).toHaveLength(20_001);
  }, 30_000);

  it('跨域时可读取文件名与导出条数 / CORS exposes the file name and count', async () => {
    // 测试环境未配置跨域来源，这里临时设置（服务端每个请求都读取该变量）并在结束时恢复
    // the test environment has no CORS origin configured: set one temporarily (read per request) and restore it
    const saved = process.env.CORS_ORIGINS;
    const origin = 'https://ai001001.github.io';
    process.env.CORS_ORIGINS = origin;
    try {
      const { res } = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'xlsx' }, a.token, { origin });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-expose-headers')).toContain('Content-Disposition');
      expect(res.headers.get('access-control-expose-headers')).toContain('X-Export-Count');
      // 未允许的来源不返回跨域头 / an unlisted origin gets no CORS headers
      const other = await download(salesExport, '/api/reports/sales/export', { currency: 'CNY', format: 'xlsx' }, a.token, { origin: 'https://evil.example' });
      expect(other.res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = saved;
    }
  });
});
