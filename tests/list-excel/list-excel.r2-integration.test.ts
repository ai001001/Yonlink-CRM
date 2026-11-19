/**
 * 列表导出 Excel 第二轮：集成测试（用 Python 标准库独立校验含多行文本、表情、XML 特殊字符的导出文件；超过导出上限时截断并
 * 标记，耗时可控；跨组织隔离；并发导出结果一致）。
 * List Excel export round 2: integration tests.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as leadExport from '@/app/api/leads/export/route';
import * as leads from '@/app/api/leads/route';
import { prisma } from '@/server/db';
import { EXPORT_MAX } from '@/server/modules/import-export';
import { call, createTenant, resetDb } from '../helpers';
import { readXlsx } from '../report-excel/xlsx-reader';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
const dir = mkdtempSync(join(tmpdir(), 'list-xlsx-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 导出线索 Excel / export leads as Excel */
async function exportLeads(token: string, query: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/leads/export');
  for (const [k, v] of Object.entries({ format: 'xlsx', ...query })) url.searchParams.set(k, v);
  const res = await leadExport.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

/** Python 标准库独立校验，返回工作表数与第一个工作表的行数 / independent check with Python's standard library */
function pythonCheck(buf: Buffer): { sheets: number; rows: number; text: string[] } {
  const file = join(dir, `${Date.now()}-${Math.random()}.xlsx`);
  writeFileSync(file, buf);
  const script = `
import json, sys, zipfile, xml.dom.minidom as m
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for n in z.namelist(): m.parseString(z.read(n))
sheet = m.parseString(z.read('xl/worksheets/sheet1.xml'))
texts = [t.firstChild.data if t.firstChild else '' for t in sheet.getElementsByTagName('t')]
wb = m.parseString(z.read('xl/workbook.xml'))
print(json.dumps({'sheets': len(wb.getElementsByTagName('sheet')), 'rows': len(sheet.getElementsByTagName('row')), 'text': texts}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, file], { maxBuffer: 64 * 1024 * 1024 }).toString());
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

describe('list excel R2', () => {
  it('Python 独立校验多行文本、表情、XML 特殊字符；跨组织隔离 / independent validation and isolation', async () => {
    const tricky = ['第一行\n第二行', '涡轮 🚀 東京', '<b>&"引号"</b>', '=HYPERLINK("http://x","y")'];
    for (const [i, description] of tricky.entries()) {
      expect((await call(leads.POST, { token: a.token, body: { name: `线索${i}`, description } })).status).toBe(201);
    }
    const { res, buf } = await exportLeads(a.token);
    expect(res.status).toBe(200);
    const py = pythonCheck(buf);
    expect(py.sheets).toBe(1);
    expect(py.rows).toBe(5);
    for (const t of tricky) expect(py.text).toContain(t);
    expect(buf.includes(Buffer.from('<f>'))).toBe(false);
    // B 组织导出只有表头 / B's export has only the header
    const other = await exportLeads(b.token);
    expect(other.res.headers.get('x-export-count')).toBe('0');
    expect(pythonCheck(other.buf).rows).toBe(1);
  });

  it('超过导出上限时截断并标记；并发导出结果一致 / truncation and determinism', async () => {
    await prisma.lead.createMany({ data: Array.from({ length: EXPORT_MAX + 1 }, (_, i) => ({ organizationId: a.org.id, ownerId: a.user.id, name: `批量${i}`, company: `公司${i % 50}` })) });
    const started = Date.now();
    const { res, buf } = await exportLeads(a.token);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(res.headers.get('x-export-count')).toBe(String(EXPORT_MAX));
    expect(res.headers.get('x-export-truncated')).toBe('true');
    expect(readXlsx(buf).sheets[0]!.rows).toHaveLength(EXPORT_MAX + 1);
    expect(pythonCheck(buf).rows).toBe(EXPORT_MAX + 1);
    // 同样的数据并发导出，文件内容一致 / identical bytes for concurrent exports of the same data
    const files = await Promise.all(Array.from({ length: 3 }, () => exportLeads(a.token, { q: '批量1' })));
    expect(files.every((f) => f.buf.equals(files[0]!.buf))).toBe(true);
  }, 120_000);
});
