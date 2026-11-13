/**
 * 备份测试辅助：创建并迁移独立的恢复目标库 yonlink_mvp_restore_test；比较两个库的表数据。
 * Backup test helpers: create and migrate the dedicated restore target yonlink_mvp_restore_test; compare table data.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

export const SOURCE_URL = process.env.TEST_DATABASE_URL!;
/** 恢复目标库（名称固定，避免误用其他库）/ restore target (fixed name so no other database is touched) */
export const TARGET_DB = 'yonlink_mvp_restore_test';
export const TARGET_URL = SOURCE_URL.replace(/\/[^/?]+(\?|$)/, `/${TARGET_DB}$1`);

/** 临时目录 / temporary directory */
export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), `yonlink-${prefix}-`));

/** 在指定库执行查询 / run a query on a database */
export async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/**
 * 重新创建目标库并执行全部迁移。
 * Recreate the target database and apply all migrations.
 */
export async function freshTarget(): Promise<void> {
  await query(SOURCE_URL, `DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
  await query(SOURCE_URL, `CREATE DATABASE ${TARGET_DB}`);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: TARGET_URL }, stdio: 'pipe', timeout: 120_000 });
}

/**
 * 表的全部行（JSON 文本，排序后便于比较）。
 * All rows of a table as sorted JSON text for comparison.
 */
export async function tableRows(url: string, table: string): Promise<string[]> {
  const rows = await query<{ j: string }>(url, `SELECT row_to_json(t)::text AS j FROM "${table}" t`);
  return rows.map((r) => r.j).sort();
}
