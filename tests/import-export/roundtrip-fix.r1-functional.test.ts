/**
 * 修复：导出防公式注入的单引号在再次导入时被保存 — 第一轮功能测试。
 * Fix: the formula-escaping quote added on export was stored on re-import — round 1 functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import { csvCell, parseCsv, toCsv, uncsvCell } from '@/server/csv';
import { prisma } from '@/server/db';
import { createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

type Handler = (req: Request, r: { params: Promise<Record<string, string>> }) => Promise<Response>;
const req = (handler: Handler, init: RequestInit = {}) =>
  handler(new Request('http://localhost/api/x', { ...init, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' } }), { params: Promise.resolve({}) });

describe('round-trip fix R1', () => {
  it('uncsvCell 还原 csvCell 加的单引号 / uncsvCell undoes csvCell', () => {
    for (const v of ['+35 518 555 0134', '=SUM(A1)', '-12', '@note', '普通', "'用户自己的引号"]) {
      const escaped = csvCell(v).replace(/^"|"$/g, '');
      expect(uncsvCell(escaped)).toBe(v);
    }
  });

  it('含 + 号国际电话与公式样内容：导出 → 导入后与原值完全一致 / export → import round-trips exactly', async () => {
    const original = [
      { name: '国际客户', phone: '+35 518 555 0134', mobile: '+1 312 555 0141', company: '=公司名看似公式' },
      { name: '-负号开头', phone: '021-5555', mobile: null, company: '@某公司' },
    ];
    for (const o of original) await prisma.lead.create({ data: { ...o, organizationId: a.org.id } });
    const exported = await (await req(leadExport.GET as Handler)).text();
    // 导出文件中这些值带防注入单引号 / exported cells carry the protective quote
    expect(exported).toContain("'+35 518 555 0134");
    await prisma.lead.deleteMany();
    const res = await req(leadImport.POST as Handler, { method: 'POST', body: JSON.stringify({ csv: exported, dryRun: false }) });
    expect((await res.json()).created).toBe(2);
    const rows = await prisma.lead.findMany({ orderBy: { name: 'asc' } });
    expect(rows.map((r) => ({ name: r.name, phone: r.phone, mobile: r.mobile, company: r.company })).sort((x, y) => x.name.localeCompare(y.name))).toEqual(
      [...original].sort((x, y) => x.name.localeCompare(y.name)),
    );
  });

  it('解析结果中的值未被改动，只有导入时还原 / parsing itself is unchanged; only import unescapes', () => {
    const rows = parseCsv(toCsv(['电话'], [['+86 10 5555 0000']]));
    expect(rows[1]).toEqual(["'+86 10 5555 0000"]);
  });
});
