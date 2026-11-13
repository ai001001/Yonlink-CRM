/**
 * 恢复命令：校验备份并恢复到明确指定的目标库与附件目录。
 * - 目标库必须已执行到备份时的同一套迁移（prisma migrate deploy）；
 * - 目标库已有数据时必须加 --replace；恢复正在使用的库前应先停止应用服务；
 * - 只校验不恢复：--verify-only。
 * Restore command: verify a backup and restore it into an explicitly given target database and attachment directory.
 *
 * 用法 / usage:
 *   npx tsx scripts/restore.ts <备份目录> --verify-only
 *   npx tsx scripts/restore.ts <备份目录> --target-url <连接串> --attachments-dir <目录> [--replace]
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { restore, verify } from './backup-lib';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'target-url': { type: 'string' },
    'attachments-dir': { type: 'string' },
    replace: { type: 'boolean', default: false },
    'verify-only': { type: 'boolean', default: false },
  },
});
const dir = positionals[0];
if (!dir) {
  console.error('用法 / usage: restore.ts <备份目录> (--verify-only | --target-url <url> --attachments-dir <dir> [--replace])');
  process.exit(2);
}

const { manifest, problems } = await verify(resolve(dir));
if (!manifest || problems.length) {
  console.error(`校验失败 / verification failed:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`校验通过 / verified: ${manifest.database} @ ${manifest.createdAt}，${Object.keys(manifest.tables).length} 张表、${Object.keys(manifest.attachments.files).length} 个附件`);
if (values['verify-only']) process.exit(0);

// 目标必须显式给出，不读取 DATABASE_URL，避免误覆盖正在使用的库 / the target must be explicit; DATABASE_URL is never used
if (!values['target-url'] || !values['attachments-dir']) {
  console.error('恢复需要 --target-url 与 --attachments-dir / --target-url and --attachments-dir are required');
  process.exit(2);
}
const result = await restore({ dir: resolve(dir), databaseUrl: values['target-url'], attachmentsDir: resolve(values['attachments-dir']), replace: values.replace });
const rows = Object.values(result.tables).reduce((n, v) => n + v, 0);
console.log(`恢复完成 / restore done: ${Object.keys(result.tables).length} 张表、${rows} 行、${result.attachments} 个附件；所有用户需重新登录`);
