/**
 * 本地 PostgreSQL（embedded-postgres，支持 linux-arm64）管理脚本。
 * Local PostgreSQL manager based on embedded-postgres (linux-arm64 supported).
 *
 * 用法 / Usage:
 *   node scripts/db.mjs start   # 首次运行自动生成 .env 并初始化 / first run generates .env and initialises
 *
 * 数据目录位于仓库外（默认 ~/yonlink-data/mvp），密码随机生成并只写入 .env（已被 .gitignore 忽略）。
 * Data lives outside the repo (default ~/yonlink-data/mvp); passwords are random and only written to .env (git-ignored).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const root = resolve(import.meta.dirname, '..');
const envFile = join(root, '.env');

/**
 * 读取或生成 .env。
 * Read .env, generating it with random secrets when missing.
 * @returns {Record<string, string>}
 */
function loadEnv() {
  if (!existsSync(envFile)) {
    const pw = randomBytes(18).toString('base64url');
    const port = 54330;
    const lines = [
      '# 永联CRM 本地环境（自动生成，勿提交）/ Yonlink-CRM local env (generated, never commit)',
      `YONLINK_DATA_DIR=${join(homedir(), 'yonlink-data', 'mvp')}`,
      `PG_PORT=${port}`,
      'PG_USER=yonlink',
      `PG_PASSWORD=${pw}`,
      `DATABASE_URL=postgresql://yonlink:${pw}@127.0.0.1:${port}/yonlink_mvp_dev`,
      `TEST_DATABASE_URL=postgresql://yonlink:${pw}@127.0.0.1:${port}/yonlink_mvp_test`,
      '',
    ];
    writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
    console.log('已生成 .env / generated .env');
  }
  return Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

const env = loadEnv();
const databaseDir = join(env.YONLINK_DATA_DIR, 'postgres');
const pg = new EmbeddedPostgres({
  databaseDir,
  user: env.PG_USER,
  password: env.PG_PASSWORD,
  port: Number(env.PG_PORT),
  persistent: true,
  // 仅监听本机 / listen on localhost only
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
});

const cmd = process.argv[2] ?? 'start';
if (cmd !== 'start') {
  console.error('未知命令 / unknown command:', cmd);
  process.exit(1);
}

const fresh = !existsSync(join(databaseDir, 'PG_VERSION'));
if (fresh) {
  console.log('初始化数据目录 / initialising', databaseDir);
  await pg.initialise();
}
await pg.start();
if (fresh) {
  await pg.createDatabase('yonlink_mvp_dev');
  await pg.createDatabase('yonlink_mvp_test');
}
console.log(`PostgreSQL 已启动 / started on 127.0.0.1:${env.PG_PORT}`);

const stop = async () => {
  await pg.stop();
  console.log('PostgreSQL 已停止 / stopped');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
