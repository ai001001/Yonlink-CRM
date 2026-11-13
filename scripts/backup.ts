/**
 * 备份命令：备份数据库（应用级逻辑备份）与附件到 BACKUP_DIR，并只保留最近 BACKUP_KEEP 份（默认 14）。
 * Backup command: back up the database (application-level) and attachments into BACKUP_DIR, keeping the newest
 * BACKUP_KEEP backups (default 14).
 *
 * 用法 / usage: DATABASE_URL=… ATTACHMENTS_DIR=… BACKUP_DIR=… npx tsx scripts/backup.ts
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { backup } from './backup-lib';

const databaseUrl = process.env.DATABASE_URL;
const outDir = process.env.BACKUP_DIR;
if (!databaseUrl || !outDir) {
  console.error('需要 DATABASE_URL 与 BACKUP_DIR / DATABASE_URL and BACKUP_DIR are required');
  process.exit(2);
}
const attachmentsDir = resolve(process.env.ATTACHMENTS_DIR ?? '.data/attachments');
const keep = Number(process.env.BACKUP_KEEP ?? '14');

const started = Date.now();
const { dir, manifest, pruned } = await backup({ databaseUrl, attachmentsDir, outDir: resolve(outDir), keep });
const rows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
console.log(
  `备份完成 / backup done: ${dir}\n` +
    `  数据库 ${manifest.database}：${Object.keys(manifest.tables).length} 张表、${rows} 行；迁移 ${manifest.migrations.length} 个\n` +
    `  附件 ${Object.keys(manifest.attachments.files).length} 个${manifest.attachments.missing.length ? `，缺失 ${manifest.attachments.missing.length} 个` : ''}\n` +
    `  清理旧备份 ${pruned.length} 份；用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
