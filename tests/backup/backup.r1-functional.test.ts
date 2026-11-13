/**
 * 备份与恢复 第一轮：功能测试（清单与文件、校验、恢复到全新目标库后逐表逐行一致、数据精度、附件、会话不备份、保留份数）。
 * Backup and restore round 1: functional tests.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as dealItems from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leadTags from '@/app/api/leads/[id]/tags/route';
import * as leads from '@/app/api/leads/route';
import * as products from '@/app/api/products/route';
import * as quotes from '@/app/api/quotes/route';
import * as tags from '@/app/api/tags/route';
import * as views from '@/app/api/views/route';
import { backup, EXCLUDED_TABLES, prune, restore, verify } from '../../scripts/backup-lib';
import { upload, SAMPLES } from '../attachments/files';
import { call, createTenant, resetDb } from '../helpers';
import { freshTarget, query, SOURCE_URL, TARGET_URL, tableRows, tempDir } from './target';

let a: Awaited<ReturnType<typeof createTenant>>;
let backupDir = '';
let liveAttachment = '';
let recycledAttachment = '';

beforeAll(async () => {
  await resetDb();
  a = await createTenant('A');
  const lead = (await call(leads.POST, { token: a.token, body: { name: '备份线索' } })).json;
  const tag = (await call(tags.POST, { token: a.token, body: { name: '备份标签' } })).json;
  await call(leadTags.PUT, { token: a.token, method: 'PUT', params: { id: lead.id }, body: { tagIds: [tag.id] } });
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '备份客户' } })).json;
  const product = (await call(products.POST, { token: a.token, body: { sku: 'B-1', name: '产品', unitPrice: '123.45' } })).json;
  const keep = (await call(deals.POST, { token: a.token, body: { name: '保留商机', accountId: acc.id } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: keep.id }, body: { productId: product.id, quantity: '3', discountPercent: '7.5' } });
  await call(quotes.POST, { token: a.token, body: { dealId: keep.id, taxPercent: '13' } });
  liveAttachment = (await upload(a.token, { leadId: lead.id }, '纪要.txt', '备份前的附件')).json.id;
  const gone = (await call(deals.POST, { token: a.token, body: { name: '已删商机', accountId: acc.id } })).json;
  await call(dealItems.POST, { token: a.token, params: { id: gone.id }, body: { productId: product.id, quantity: '1' } });
  await call(quotes.POST, { token: a.token, body: { dealId: gone.id } });
  recycledAttachment = (await upload(a.token, { dealId: gone.id }, '合同.pdf', SAMPLES.pdf)).json.id;
  await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: gone.id } });
  await call(views.POST, { token: a.token, body: { entity: 'leads', name: '视图', filters: { status: 'NEW' }, shared: true } });
  const out = tempDir('backup');
  backupDir = (await backup({ databaseUrl: SOURCE_URL, attachmentsDir: process.env.ATTACHMENTS_DIR!, outDir: out })).dir;
}, 120_000);

describe('backup R1 manifest', () => {
  it('清单：全部业务表（不含会话与迁移表）、行数与源库一致、迁移清单、权限 700/600 / manifest content', async () => {
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
    const all = (await query<{ t: string }>(SOURCE_URL, "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).map((r) => r.t);
    expect(Object.keys(manifest.tables).sort()).toEqual(all.filter((t) => !EXCLUDED_TABLES.includes(t)).sort());
    for (const [table, t] of Object.entries(manifest.tables as Record<string, { rows: number }>)) {
      const [row] = await query<{ n: number }>(SOURCE_URL, `SELECT count(*)::int AS n FROM "${table}"`);
      expect(t.rows, table).toBe(row!.n);
    }
    const migrations = await query<{ name: string }>(SOURCE_URL, 'SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name');
    expect(manifest.migrations.map((m: { name: string }) => m.name)).toEqual(migrations.map((m) => m.name));
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(backupDir, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(backupDir, manifest.tables.leads.file)).mode & 0o777).toBe(0o600);
  });

  it('附件：在用与回收站快照中的附件都备份，校验和正确 / live and recycled attachments are included', async () => {
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest.attachments.files).sort()).toEqual([`${a.org.id}/${liveAttachment}`, `${a.org.id}/${recycledAttachment}`].sort());
    expect(manifest.attachments.missing).toEqual([]);
    const pdf = readFileSync(join(backupDir, 'attachments', a.org.id, recycledAttachment));
    expect(new Uint8Array(pdf)).toEqual(SAMPLES.pdf);
    expect(manifest.attachments.files[`${a.org.id}/${recycledAttachment}`]).toBe(createHash('sha256').update(pdf).digest('hex'));
  });

  it('校验通过；会话不在备份中 / verify passes; sessions are excluded', async () => {
    const r = await verify(backupDir);
    expect(r.problems).toEqual([]);
    expect(Object.keys(r.manifest!.tables)).not.toContain('sessions');
  });
});

describe('backup R1 restore', () => {
  it('恢复到全新目标库：每张表逐行一致；会话为空；附件文件一致 / restore reproduces every row', async () => {
    await freshTarget();
    const attachmentsDir = tempDir('restored-files');
    const result = await restore({ dir: backupDir, databaseUrl: TARGET_URL, attachmentsDir });
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
    expect(Object.keys(result.tables).sort()).toEqual(Object.keys(manifest.tables).sort());
    for (const table of Object.keys(manifest.tables)) expect(await tableRows(TARGET_URL, table), table).toEqual(await tableRows(SOURCE_URL, table));
    expect((await query<{ n: number }>(TARGET_URL, 'SELECT count(*)::int AS n FROM sessions'))[0]!.n).toBe(0);
    expect(result.attachments).toBe(2);
    expect(readFileSync(join(attachmentsDir, a.org.id, liveAttachment), 'utf8')).toBe('备份前的附件');
    expect(statSync(join(attachmentsDir, a.org.id, liveAttachment)).mode & 0o777).toBe(0o600);
  }, 180_000);

  it('数据精度：金额、折扣、时间（微秒）、JSON 快照、文本数组、枚举原样恢复 / precision is preserved', async () => {
    const sql = `SELECT q.total::text, q.tax_amount::text, q.status::text, q.created_at::text,
      (SELECT discount_percent::text FROM deal_line_items LIMIT 1) AS discount,
      (SELECT reserved_numbers::text FROM recycle_bin_items LIMIT 1) AS reserved,
      (SELECT payload::text FROM recycle_bin_items LIMIT 1) AS payload
      FROM quotes q ORDER BY q.quote_number LIMIT 1`;
    const [src] = await query(SOURCE_URL, sql);
    const [dst] = await query(TARGET_URL, sql);
    expect(dst).toEqual(src);
    expect(src!.discount).toBe('7.50');
    expect(String(src!.reserved)).toMatch(/^\{QT-\d{4}-\d{4}\}$/);
  });

  it('追加型审计触发器在恢复后仍然有效（replica 只在恢复事务内）/ the audit trigger is still enforced', async () => {
    await expect(query(TARGET_URL, "UPDATE audit_logs SET action = 'x'")).rejects.toThrow();
  });
});

describe('backup R1 retention', () => {
  it('只保留最近 N 份，忽略不符合命名或不完整的目录 / prune keeps the newest N', async () => {
    const out = tempDir('prune');
    for (const n of ['20260101-000000Z', '20260102-000000Z', '20260103-000000Z', '20260104-000000Z']) {
      mkdirSync(join(out, n));
      (await import('node:fs')).writeFileSync(join(out, n, 'manifest.json'), '{}');
    }
    mkdirSync(join(out, '20260105-000000Z'));
    mkdirSync(join(out, 'keep-me'));
    const removed = await prune(out, 2);
    expect(removed).toEqual(['20260101-000000Z', '20260102-000000Z']);
    expect((await import('node:fs')).readdirSync(out).sort()).toEqual(['20260103-000000Z', '20260104-000000Z', '20260105-000000Z', 'keep-me']);
  });
});
