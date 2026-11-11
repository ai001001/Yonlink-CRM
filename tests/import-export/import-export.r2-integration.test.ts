/**
 * 导入导出 第二轮：集成测试（角色权限、负责人规则、组织隔离、异常行与异常文件、公式注入、导出上限、审计不含原文）。
 * Import / export round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountImport from '@/app/api/accounts/import/route';
import * as dealExport from '@/app/api/deals/export/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leadTemplate from '@/app/api/leads/import/template/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { addUser, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string; email: string }; token: string };
type Handler = (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response>;
let admin: Who & { org: { id: string } };
let manager: Who;
let sales: Who;
let viewer: Who;
beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
});

async function get(handler: Handler, who?: Who, query: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/x');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await handler(new Request(url, { headers: who ? { authorization: `Bearer ${who.token}` } : {} }), { params: Promise.resolve({}) });
  const text = await res.text();
  return { status: res.status, text, rows: res.ok ? parseCsv(text) : [], headers: res.headers };
}

async function imp(handler: Handler, who: Who | undefined, body: unknown) {
  const res = await handler(
    new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, json: await res.json() };
}

describe('import/export R2 permissions', () => {
  it('导出仅管理员与经理；销售代表与只读用户 403 / export is admin and manager only', async () => {
    expect((await get(leadExport.GET, admin)).status).toBe(200);
    expect((await get(dealExport.GET, manager)).status).toBe(200);
    expect((await get(leadExport.GET, sales)).status).toBe(403);
    expect((await get(leadExport.GET, viewer)).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: { endsWith: '.export' } } })).toBe(2);
  });

  it('只读用户不能导入；销售代表可导入，负责人只能是自己 / read-only cannot import; sales own only', async () => {
    const csv = `姓名,负责人邮箱\n甲,\n乙,${sales.user.email}\n丙,${manager.user.email}`;
    expect((await imp(leadImport.POST, viewer, { csv, dryRun: false })).status).toBe(403);
    const r = await imp(leadImport.POST, sales, { csv, dryRun: false });
    expect(r.json).toMatchObject({ created: 2, errors: [{ row: 4, field: 'ownerEmail', reason: 'owner_forbidden' }] });
    expect(await prisma.lead.count({ where: { ownerId: sales.user.id } })).toBe(2);
  });

  it('经理可把导入记录指派给他人 / managers can assign imported records', async () => {
    const r = await imp(leadImport.POST, manager, { csv: `姓名,负责人邮箱\n甲,${sales.user.email.toUpperCase()}`, dryRun: false });
    expect(r.json.created).toBe(1);
    expect((await prisma.lead.findFirstOrThrow()).ownerId).toBe(sales.user.id);
  });

  it('未登录 401 / unauthenticated → 401', async () => {
    expect((await get(leadExport.GET)).status).toBe(401);
    expect((await get(leadTemplate.GET)).status).toBe(401);
    expect((await imp(leadImport.POST, undefined, { csv: '姓名\n甲', dryRun: true })).status).toBe(401);
  });
});

describe('import/export R2 isolation', () => {
  it('其他组织用户的邮箱不能作为负责人；停用用户也不行 / owners must be active users of this org', async () => {
    const other = await createTenant('B', 'ADMIN');
    await prisma.user.update({ where: { id: viewer.user.id }, data: { isActive: false } });
    const r = await imp(leadImport.POST, admin, { csv: `姓名,负责人邮箱\n甲,${other.user.email}\n乙,${viewer.user.email}`, dryRun: true });
    expect(r.json.errors).toEqual([
      { row: 2, field: 'ownerEmail', reason: 'owner_not_found' },
      { row: 3, field: 'ownerEmail', reason: 'owner_not_found' },
    ]);
  });

  it('查重只在本组织范围；导入记录归属本组织 / duplicates are organization scoped', async () => {
    const other = await createTenant('B', 'ADMIN');
    await imp(leadImport.POST, other, { csv: '姓名,邮箱\n外部,same@example.com', dryRun: false });
    const r = await imp(leadImport.POST, admin, { csv: '姓名,邮箱\n内部,same@example.com', dryRun: false });
    expect(r.json).toMatchObject({ created: 1, duplicates: [] });
    expect(await prisma.lead.count({ where: { organizationId: admin.org.id } })).toBe(1);
  });

  it('导出不含其他组织数据 / exports never include other organizations', async () => {
    const other = await createTenant('B', 'ADMIN');
    await imp(leadImport.POST, other, { csv: '姓名\n外部机密线索', dryRun: false });
    const out = await get(leadExport.GET, admin);
    expect(out.text).not.toContain('外部机密线索');
  });
});

describe('import/export R2 invalid rows & files', () => {
  it('逐行错误：必填、邮箱、长度、枚举、已转化状态、联系人邮箱；行号正确 / row errors with correct line numbers', async () => {
    const csv = ['姓名,邮箱,线索来源,线索状态', ',a@example.com,,', '甲,not-an-email,,', `${'长'.repeat(101)},,,`, '乙,,电视,,', '丙,,,已转化', '丁,ok@example.com,展会,新线索'].join('\n');
    const r = await imp(leadImport.POST, admin, { csv, dryRun: true });
    expect(r.json.valid).toBe(1);
    expect(r.json.errors).toEqual([
      { row: 2, field: 'name', reason: 'required' },
      { row: 3, field: 'email', reason: 'invalid_email' },
      { row: 4, field: 'name', reason: 'too_long' },
      { row: 5, field: 'source', reason: 'invalid_value' },
      { row: 6, field: 'status', reason: 'invalid_value' },
    ]);
    const acc = await imp(accountImport.POST, admin, { csv: '客户名称,联系人姓名,联系人邮箱\n甲,,x@example.com\n乙,陈,bad', dryRun: true });
    expect(acc.json.errors).toEqual([
      { row: 2, field: 'contact.name', reason: 'required' },
      { row: 3, field: 'contact.email', reason: 'invalid_email' },
    ]);
  });

  it('错误行不写入，有效行写入 / only valid rows are written', async () => {
    const r = await imp(leadImport.POST, admin, { csv: '姓名,邮箱\n好,g@example.com\n坏,bad\n也好,', dryRun: false });
    expect(r.json).toMatchObject({ created: 2, valid: 2 });
    expect((await prisma.lead.findMany({ orderBy: { name: 'asc' } })).map((l) => l.name)).toEqual(['也好', '好']);
  });

  it.each([
    ['只有表头 / header only', '姓名,邮箱', 'no_rows'],
    ['缺少必填列 / missing name column', '公司\n甲公司', 'missing_column:姓名'],
    ['引号未闭合 / unterminated quote', '姓名\n"甲', 'unterminated_quote'],
    ['超过 2000 行 / too many rows', ['姓名', ...Array.from({ length: 2001 }, (_, i) => `n${i}`)].join('\n'), 'too_many_rows'],
  ])('文件级错误：%s → 400', async (_l, csv, code) => {
    const r = await imp(leadImport.POST, admin, { csv, dryRun: true });
    expect(r.status).toBe(400);
    expect(r.json.error.details.csv).toEqual([code]);
  });

  it('2000 行边界可导入 / exactly 2000 rows are accepted', async () => {
    const csv = ['姓名', ...Array.from({ length: 2000 }, (_, i) => `批量${i}`)].join('\n');
    const r = await imp(leadImport.POST, admin, { csv, dryRun: false });
    expect(r.json.created).toBe(2000);
  });

  it.each([[{ csv: '', dryRun: true }], [{ csv: 'x'.repeat(1_000_001), dryRun: true }], [{ csv: '姓名\n甲', dryRun: 'no' }], [{ csv: '姓名\n甲', duplicates: 'merge' }], [{ csv: '姓名\n甲', organizationId: '00000000-0000-4000-8000-000000000000' }]])(
    '非法请求 %# → 400',
    async (body) => {
      expect((await imp(leadImport.POST, admin, body)).status).toBe(400);
    },
  );
});

describe('import/export R2 security & limits', () => {
  it('导出时对公式开头的内容加单引号 / formula-like values are neutralised in exports', async () => {
    await imp(leadImport.POST, admin, { csv: '姓名,公司\n"=HYPERLINK(""http://evil.example"")",+SUM(1)', dryRun: false });
    const out = await get(leadExport.GET, admin);
    expect(out.rows[1]![0]!.startsWith("'=")).toBe(true);
    expect(out.rows[1]![1]!.startsWith("'+")).toBe(true);
    // 数据库中保存原值，只在导出时转义 / the stored value is unchanged
    expect((await prisma.lead.findFirstOrThrow()).name).toBe('=HYPERLINK("http://evil.example")');
  });

  it('超过 10000 条时只导出前 10000 条并标记截断 / exports cap at 10000 rows and flag truncation', async () => {
    await prisma.lead.createMany({ data: Array.from({ length: 10_001 }, (_, i) => ({ organizationId: admin.org.id, name: `L${i}` })) });
    const out = await get(leadExport.GET, admin);
    expect(out.rows).toHaveLength(10_001);
    expect(out.headers.get('x-export-truncated')).toBe('true');
    expect(out.headers.get('x-export-count')).toBe('10000');
  });

  it('导入审计只记数量，不含文件原文 / import audit stores counts only', async () => {
    await imp(leadImport.POST, admin, { csv: '姓名,邮箱,备注\n秘密客户,secret.person@example.com,私密备注内容', dryRun: false });
    const summary = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.import' } });
    expect(summary.changes).toEqual({ total: 1, created: 1, duplicates: 0, errors: 0, duplicatePolicy: 'skip' });
    const dump = JSON.stringify(await prisma.auditLog.findMany());
    expect(dump).not.toContain('secret.person@example.com');
    expect(dump).not.toContain('私密备注内容');
  });

  it('预检不写审计，不产生任何记录 / dry runs write nothing at all', async () => {
    await imp(leadImport.POST, admin, { csv: '姓名\n甲\n乙', dryRun: true });
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});
