/**
 * 附件 第一轮：功能测试（上传与存储、类型与文件头校验、文件名清理、列表、下载响应头、删除、大小与数量上限、回收站联动、演示数据）。
 * Attachments round 1: functional tests.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_ORG_NAME, demoAttachments } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as attachmentItem from '@/app/api/attachments/[id]/route';
import * as attachments from '@/app/api/attachments/route';
import * as accounts from '@/app/api/accounts/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as binItem from '@/app/api/recycle-bin/[id]/route';
import * as restoreRoute from '@/app/api/recycle-bin/[id]/restore/route';
import { prisma } from '@/server/db';
import { cleanFileName, MAX_FILE_BYTES } from '@/server/modules/attachments';
import { call, createTenant, resetDb } from '../helpers';
import { fetchFile, onDisk, readDisk, SAMPLES, upload } from './files';

let a: Awaited<ReturnType<typeof createTenant>>;
let lead: { id: string };
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  lead = (await call(leads.POST, { token: a.token, body: { name: '附件线索' } })).json;
});

describe('attachments R1 upload & types', () => {
  it('上传：元数据、磁盘文件与 SHA-256、审计只记名称与大小 / upload stores file and metadata', async () => {
    const r = await upload(a.token, { leadId: lead.id }, '拜访纪要.txt', '客户关注交期与质保。');
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ fileName: '拜访纪要.txt', contentType: 'text/plain', leadId: lead.id, uploadedBy: { id: a.user.id } });
    const bytes = new TextEncoder().encode('客户关注交期与质保。');
    expect(r.json.size).toBe(bytes.byteLength);
    expect(new Uint8Array(readDisk(a.org.id, r.json.id))).toEqual(bytes);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: r.json.id } });
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'attachment.create', entityId: r.json.id } });
    expect(log.changes).toMatchObject({ after: { fileName: '拜访纪要.txt', size: bytes.byteLength, leadId: lead.id } });
    expect(JSON.stringify(log.changes)).not.toContain('交期');
  });

  it('允许的类型按文件头识别；扩展名大小写不敏感 / allowed types by magic bytes', async () => {
    const cases: [string, Uint8Array | string, string][] = [
      ['报价.PDF', SAMPLES.pdf, 'application/pdf'],
      ['照片.png', SAMPLES.png, 'image/png'],
      ['照片.jpeg', SAMPLES.jpg, 'image/jpeg'],
      ['合同.docx', SAMPLES.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['旧表格.xls', SAMPLES.xls, 'application/vnd.ms-excel'],
      ['价格.csv', 'SKU,价格\r\nA,1\r\n', 'text/csv'],
    ];
    for (const [name, bytes, type] of cases) {
      const r = await upload(a.token, { leadId: lead.id }, name, bytes);
      expect(r.status, name).toBe(201);
      expect(r.json.contentType).toBe(type);
    }
  });

  it('不允许的类型、内容与扩展名不符、空文件被拒绝 / disallowed, mismatched and empty files', async () => {
    const reject = async (name: string, bytes: Uint8Array | string, code: string) => {
      const r = await upload(a.token, { leadId: lead.id }, name, bytes);
      expect(r.status, name).toBe(400);
      expect(r.json.error.details.file, name).toEqual([code]);
    };
    await reject('page.html', '<script>alert(1)</script>', 'type_not_allowed');
    await reject('logo.svg', '<svg onload="alert(1)"/>', 'type_not_allowed');
    await reject('tool.exe', 'MZ', 'type_not_allowed');
    await reject('noext', 'abc', 'type_not_allowed');
    await reject('fake.pdf', '<html>not a pdf</html>', 'content_mismatch');
    await reject('fake.png', SAMPLES.pdf, 'content_mismatch');
    await reject('binary.txt', new Uint8Array([0x41, 0x00, 0x42]), 'content_mismatch');
    await reject('empty.txt', new Uint8Array([]), 'empty');
    expect(await prisma.attachment.count()).toBe(0);
  });

  it('文件名清理：去掉路径与控制字符，超长保留扩展名 / file names are sanitised', async () => {
    expect(cleanFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(cleanFileName('C:\\Users\\x\\报价\u0007.pdf')).toBe('报价.pdf');
    const long = cleanFileName(`${'名'.repeat(300)}.xlsx`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('.xlsx')).toBe(true);
    const r = await upload(a.token, { leadId: lead.id }, '../../../etc/notes.txt', 'x');
    expect(r.json.fileName).toBe('notes.txt');
    expect(onDisk(a.org.id, r.json.id)).toBe(true);
  });
});

describe('attachments R1 list, download, delete & limits', () => {
  it('列表按记录、最新在前；下载返回原内容与安全响应头 / list and download', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const first = (await upload(a.token, { leadId: lead.id }, '一.txt', '1')).json;
    const second = (await upload(a.token, { leadId: lead.id }, '二 报价单.pdf', SAMPLES.pdf)).json;
    await upload(a.token, { accountId: acc.id }, '客户.txt', '2');
    const list = (await call(attachments.GET, { token: a.token, query: { leadId: lead.id } })).json;
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([second.id, first.id]);
    expect(list.maxBytes).toBe(MAX_FILE_BYTES);
    expect(list.extensions).toContain('pdf');
    const f = await fetchFile(a.token, second.id);
    expect(f.status).toBe(200);
    expect(f.bytes).toEqual(SAMPLES.pdf);
    expect(f.headers.get('content-type')).toBe('application/pdf');
    expect(f.headers.get('content-disposition')).toBe(`attachment; filename="_ ___.pdf"; filename*=UTF-8''${encodeURIComponent('二 报价单.pdf')}`);
    expect(f.headers.get('x-content-type-options')).toBe('nosniff');
    expect(f.headers.get('content-security-policy')).toContain('sandbox');
    expect(f.headers.get('cache-control')).toBe('no-store');
  });

  it('删除：记录与磁盘文件都删除，写审计 / delete removes row and file', async () => {
    const x = (await upload(a.token, { leadId: lead.id }, '删除.txt', 'x')).json;
    expect((await call(attachmentItem.DELETE, { token: a.token, method: 'DELETE', params: { id: x.id } })).status).toBe(204);
    expect(onDisk(a.org.id, x.id)).toBe(false);
    expect(await prisma.attachment.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'attachment.delete', entityId: x.id } })).toBe(1);
    expect((await fetchFile(a.token, x.id)).status).toBe(404);
  });

  it('大小上限 10 MB（恰好 10 MB 可以）与每条记录 50 个 / size and count limits', async () => {
    const exact = new Uint8Array(MAX_FILE_BYTES).fill(0x61);
    expect((await upload(a.token, { leadId: lead.id }, '恰好.txt', exact)).status).toBe(201);
    const over = await upload(a.token, { leadId: lead.id }, '超出.txt', new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61));
    expect(over.status).toBe(413);
    expect(over.json.error.details.file).toEqual(['too_large']);
    await prisma.attachment.createMany({
      data: Array.from({ length: 49 }, (_, i) => ({ organizationId: a.org.id, leadId: lead.id, fileName: `${i}.txt`, contentType: 'text/plain', size: 1, sha256: 'a'.repeat(64), uploadedById: a.user.id })),
    });
    const r = await upload(a.token, { leadId: lead.id }, '第51个.txt', 'x');
    expect(r.status).toBe(400);
    expect(r.json.error.details.file).toEqual(['limit']);
  });
});

describe('attachments R1 recycle bin & demo', () => {
  it('删除商机：附件进入回收站且文件保留；恢复后可下载；再次删除并彻底删除后文件移除 / recycle bin keeps files until purge', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: a.token, body: { name: '带附件商机', accountId: acc.id } })).json;
    const x = (await upload(a.token, { dealId: deal.id }, '合同.pdf', SAMPLES.pdf)).json;
    await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: deal.id } });
    expect(await prisma.attachment.count()).toBe(0);
    expect(onDisk(a.org.id, x.id)).toBe(true);
    let item = await prisma.recycleBinItem.findFirstOrThrow();
    expect(item.summary).toMatchObject({ attachments: 1 });
    expect((await call(restoreRoute.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    expect((await fetchFile(a.token, x.id)).bytes).toEqual(SAMPLES.pdf);
    await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: deal.id } });
    item = await prisma.recycleBinItem.findFirstOrThrow();
    expect((await call(binItem.DELETE, { token: a.token, method: 'DELETE', params: { id: item.id } })).status).toBe(204);
    expect(onDisk(a.org.id, x.id)).toBe(false);
  });

  it('演示数据：附件记录与磁盘文件一致（SHA-256）/ demo attachments match their files', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.attachment.findMany({ where: { organizationId: org.id } });
    expect(rows).toHaveLength(demoAttachments(buildDemoData()).length);
    for (const r of rows) expect(createHash('sha256').update(readDisk(org.id, r.id)).digest('hex')).toBe(r.sha256);
  });
});
