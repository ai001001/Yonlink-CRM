/**
 * 备份与恢复 第二轮：集成测试（篡改检测、迁移不一致、非空目标需 replace、并发锁、失败清理、缺失附件、命令行退出码）。
 * Backup and restore round 2: integration tests.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/app/api/leads/route';
import { backup, restore, verify } from '../../scripts/backup-lib';
import { diskPath, upload } from '../attachments/files';
import { call, createTenant, resetDb } from '../helpers';
import { freshTarget, query, SOURCE_URL, TARGET_URL, tableRows, tempDir } from './target';

let a: Awaited<ReturnType<typeof createTenant>>;
let backupDir = '';
let missingId = '';

/** 复制备份目录 / copy a backup directory */
function copyBackup(): string {
  const dest = join(tempDir('copy'), 'b');
  execFileSync('cp', ['-a', backupDir, dest]);
  return dest;
}

/** 运行命令行脚本，返回退出码与输出 / run a CLI script and return its exit code and output */
function cli(script: string, args: string[], env: Record<string, string> = {}) {
  try {
    const out = execFileSync('npx', ['tsx', `scripts/${script}`, ...args], { env: { ...process.env, ...env }, stdio: 'pipe', timeout: 120_000 }).toString();
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

beforeAll(async () => {
  await resetDb();
  a = await createTenant('A');
  const lead = (await call(leads.POST, { token: a.token, body: { name: '备份线索' } })).json;
  await upload(a.token, { leadId: lead.id }, '在.txt', '在磁盘上');
  missingId = (await upload(a.token, { leadId: lead.id }, '缺.txt', '将被删除')).json.id;
  rmSync(diskPath(a.org.id, missingId));
  backupDir = (await backup({ databaseUrl: SOURCE_URL, attachmentsDir: process.env.ATTACHMENTS_DIR!, outDir: tempDir('backup2') })).dir;
  await freshTarget();
}, 180_000);

describe('backup R2 integrity', () => {
  it('附件文件缺失时备份仍完成并在清单中列出 / missing attachment files are listed', async () => {
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
    expect(manifest.attachments.missing).toEqual([`${a.org.id}/${missingId}`]);
    expect(Object.keys(manifest.attachments.files)).toHaveLength(1);
  });

  it('数据文件被篡改：校验失败，恢复中止且不改动目标库 / tampered data aborts the restore', async () => {
    const dir = copyBackup();
    const file = join(dir, 'data', 'leads.ndjson.gz');
    const bytes = readFileSync(file);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5]! + 1) % 256;
    writeFileSync(file, bytes);
    expect((await verify(dir)).problems).toEqual(['数据文件校验失败：leads / checksum mismatch']);
    await expect(restore({ dir, databaseUrl: TARGET_URL, attachmentsDir: tempDir('x') })).rejects.toThrow(/verification failed/);
    expect((await query<{ n: number }>(TARGET_URL, 'SELECT count(*)::int AS n FROM leads'))[0]!.n).toBe(0);
  });

  it('附件被篡改、清单缺失：校验失败 / tampered attachment and missing manifest', async () => {
    const dir = copyBackup();
    const att = readdirSync(join(dir, 'attachments', a.org.id))[0]!;
    writeFileSync(join(dir, 'attachments', a.org.id, att), 'changed');
    expect((await verify(dir)).problems).toHaveLength(1);
    rmSync(join(dir, 'manifest.json'));
    expect((await verify(dir)).manifest).toBeNull();
  });
});

describe('backup R2 restore safety', () => {
  it('目标库迁移不一致时拒绝恢复 / migration mismatch is refused', async () => {
    const [last] = await query<{ name: string }>(TARGET_URL, 'SELECT migration_name AS name FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 1');
    await query(TARGET_URL, 'UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2', ['0'.repeat(64), last!.name]);
    try {
      await expect(restore({ dir: backupDir, databaseUrl: TARGET_URL, attachmentsDir: tempDir('x') })).rejects.toThrow(/migration mismatch/);
    } finally {
      await freshTarget();
    }
  }, 180_000);

  it('非空目标：不加 replace 拒绝；加 replace 后清空并与备份一致 / non-empty targets need replace', async () => {
    await restore({ dir: backupDir, databaseUrl: TARGET_URL, attachmentsDir: tempDir('x') });
    const [org] = await query<{ id: string }>(TARGET_URL, 'SELECT id FROM organizations LIMIT 1');
    await query(TARGET_URL, "INSERT INTO leads (id, organization_id, name, status, created_at, updated_at) VALUES (gen_random_uuid(), $1, '恢复后新增', 'NEW', now(), now())", [org!.id]);
    await query(TARGET_URL, "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) SELECT gen_random_uuid(), id, md5(random()::text), now() + interval '1 hour', now() FROM users LIMIT 1");
    await expect(restore({ dir: backupDir, databaseUrl: TARGET_URL, attachmentsDir: tempDir('x') })).rejects.toThrow(/target is not empty/);
    await restore({ dir: backupDir, databaseUrl: TARGET_URL, attachmentsDir: tempDir('x'), replace: true });
    expect(await tableRows(TARGET_URL, 'leads')).toEqual(await tableRows(SOURCE_URL, 'leads'));
    expect((await query<{ n: number }>(TARGET_URL, 'SELECT count(*)::int AS n FROM sessions'))[0]!.n).toBe(0);
  }, 180_000);
});

describe('backup R2 robustness & CLI', () => {
  it('并发：锁文件存在时备份失败且不留下目录 / a held lock blocks a second backup', async () => {
    const out = tempDir('lock');
    writeFileSync(join(out, '.lock'), '');
    await expect(backup({ databaseUrl: SOURCE_URL, attachmentsDir: process.env.ATTACHMENTS_DIR!, outDir: out })).rejects.toThrow(/another backup is running/);
    expect(readdirSync(out)).toEqual(['.lock']);
  });

  it('数据库不可用：失败并清理不完整目录与锁 / failures clean up', async () => {
    const out = tempDir('fail');
    const bad = SOURCE_URL.replace(/\/[^/?]+(\?|$)/, '/yonlink_no_such_db$1');
    await expect(backup({ databaseUrl: bad, attachmentsDir: process.env.ATTACHMENTS_DIR!, outDir: out })).rejects.toThrow();
    expect(readdirSync(out)).toEqual([]);
  });

  it('命令行：缺少参数 2、仅校验 0、篡改 1、恢复需显式目标 2 / CLI exit codes', async () => {
    expect(cli('backup.ts', [], { BACKUP_DIR: '' }).code).toBe(2);
    expect(cli('restore.ts', []).code).toBe(2);
    const ok = cli('restore.ts', [backupDir, '--verify-only']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('校验通过');
    expect(cli('restore.ts', [backupDir]).code).toBe(2);
    const dir = copyBackup();
    writeFileSync(join(dir, 'data', 'users.ndjson.gz'), 'x');
    expect(cli('restore.ts', [dir, '--verify-only']).code).toBe(1);
    const out = tempDir('cli');
    const r = cli('backup.ts', [], { BACKUP_DIR: out, DATABASE_URL: SOURCE_URL });
    expect(r.code).toBe(0);
    expect(r.out).toContain('备份完成');
    expect(readdirSync(out).filter((n) => existsSync(join(out, n, 'manifest.json')))).toHaveLength(1);
  }, 120_000);
});
