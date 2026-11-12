/**
 * 修复：导出 → 导入单引号 — 第二轮集成测试（用户自带引号保留、未转义的公式内容按文本保存、导出仍防注入、客户导入同样生效）。
 * Fix: export → import quotes — round 2 integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountExport from '@/app/api/accounts/export/route';
import * as accountImport from '@/app/api/accounts/import/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

type Handler = (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = (handler: Handler, body?: unknown) =>
  handler(
    new Request('http://localhost/api/x', {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({}) },
  );

describe('round-trip fix R2', () => {
  it('用户自带的单引号（后面不是公式字符）原样保留 / user quotes not followed by formula chars are kept', async () => {
    await call(leadImport.POST as Handler, { csv: "姓名,备注\n'甲',\"'注释'\"", dryRun: false });
    const l = await prisma.lead.findFirstOrThrow();
    expect([l.name, l.description]).toEqual(["'甲'", "'注释'"]);
  });

  it('CSV 中未转义的公式样内容按普通文本保存，导出时再次加单引号 / raw formula-like text is stored as text and escaped again on export', async () => {
    await call(leadImport.POST as Handler, { csv: '姓名\n=1+1', dryRun: false });
    expect((await prisma.lead.findFirstOrThrow()).name).toBe('=1+1');
    const rows = parseCsv(await (await call(leadExport.GET as Handler)).text());
    expect(rows[1]![0]).toBe("'=1+1");
  });

  it('客户导出 → 导入同样一致 / accounts round-trip too', async () => {
    await prisma.account.create({ data: { organizationId: a.org.id, name: '海外客户', phone: '+49 211 555 0182', website: 'https://x.example' } });
    const csv = await (await call(accountExport.GET as Handler)).text();
    await prisma.account.deleteMany();
    const r = await (await call(accountImport.POST as Handler, { csv, dryRun: false })).json();
    expect(r.created).toBe(1);
    expect((await prisma.account.findFirstOrThrow()).phone).toBe('+49 211 555 0182');
  });

  it('预检阶段同样按还原后的值校验与查重 / dry runs validate and dedupe on the unescaped value', async () => {
    await prisma.lead.create({ data: { organizationId: a.org.id, name: '已存在', email: 'dup@example.com' } });
    const r = await (await call(leadImport.POST as Handler, { csv: "姓名,邮箱,电话\n'=甲,dup@example.com,'+1 555", dryRun: true })).json();
    expect(r).toMatchObject({ total: 1, valid: 0, duplicates: [{ row: 2, value: 'dup@example.com' }], errors: [] });
  });
});
