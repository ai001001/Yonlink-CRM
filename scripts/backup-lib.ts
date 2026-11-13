/**
 * 备份与恢复核心逻辑（应用级逻辑备份，不依赖 pg_dump）。
 *
 * 备份 / Backup
 * - 在一个 REPEATABLE READ 只读事务（一致性快照）中逐表导出：每行 row_to_json → NDJSON → gzip，文件 data/<表>.ndjson.gz。
 * - 表结构由迁移管理，不导出；清单记录已完成的迁移（名称与校验和），恢复时要求目标库迁移一致。
 * - 不导出 sessions（会话令牌哈希）：恢复后所有用户需重新登录。
 * - 附件：只复制快照中被引用的文件（附件表与回收站快照中的附件），保持与数据库一致；缺失的文件记录在清单中。
 * - 清单 manifest.json 记录每个文件的 SHA-256；目录 700、文件 600；同一备份目录同时只允许一个备份（锁文件）。
 *
 * 恢复 / Restore
 * - 先校验全部文件 SHA-256，再核对目标库迁移；目标库有数据时必须显式 replace（先清空再写入）。
 * - 在一个事务内以 session_replication_role = replica 写入（快照本身一致，避免外键顺序与追加型审计触发器问题），
 *   该设置仅对本事务有效；按列名 json_populate_recordset 写回，精度（numeric、时间、JSON、数组、枚举）不变。
 *
 * Application-level logical backup (no pg_dump): a consistent REPEATABLE READ snapshot exported table by table as gzip
 * NDJSON; schema comes from migrations (recorded and checked on restore); sessions are excluded; only referenced
 * attachment files are copied; a SHA-256 manifest guards integrity. Restore verifies checksums and migrations, requires
 * an explicit replace for non-empty targets and writes everything in one transaction with replica mode.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';

/** 清单版本 / manifest version */
export const MANIFEST_VERSION = 1;
/** 不备份的表 / tables never backed up */
export const EXCLUDED_TABLES = ['_prisma_migrations', 'sessions'];
const BATCH = 500;
const DIR_PATTERN = /^\d{8}-\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 备份清单 / backup manifest */
export interface Manifest {
  version: number;
  createdAt: string;
  database: string;
  migrations: { name: string; checksum: string }[];
  tables: Record<string, { rows: number; file: string; sha256: string }>;
  sequences: Record<string, string>;
  attachments: { files: Record<string, string>; missing: string[] };
}

/** SHA-256 / file hash */
async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/** 带引号的标识符 / quoted identifier */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * 公共 schema 中需要备份的表（按名称排序）。
 * Tables to back up from the public schema (sorted).
 */
async function tablesOf(client: pg.Client): Promise<string[]> {
  const r = await client.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return r.rows.map((x) => x.name).filter((n) => !EXCLUDED_TABLES.includes(n));
}

/**
 * 已完成的迁移。
 * Finished migrations.
 */
async function migrationsOf(client: pg.Client): Promise<{ name: string; checksum: string }[]> {
  const r = await client.query<{ name: string; checksum: string }>(
    'SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
  );
  return r.rows;
}

/** 备份参数 / backup options */
export interface BackupOptions {
  databaseUrl: string;
  attachmentsDir: string;
  /** 备份根目录（其下每次备份一个子目录）/ backup root (one sub-directory per backup) */
  outDir: string;
  /** 保留最近几份（默认 14）/ how many backups to keep (default 14) */
  keep?: number;
  now?: Date;
}

/**
 * 执行一次备份，返回备份目录与清单。
 * Run one backup; returns the backup directory and manifest.
 */
export async function backup(opts: BackupOptions): Promise<{ dir: string; manifest: Manifest; pruned: string[] }> {
  await mkdir(opts.outDir, { recursive: true, mode: 0o700 });
  const lockPath = join(opts.outDir, '.lock');
  // 锁文件：同一备份根目录同时只允许一个备份 / lock file: one backup at a time per root
  const lock = await open(lockPath, 'wx').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EEXIST') throw new Error(`另一个备份正在进行（${lockPath}）/ another backup is running`);
    throw err;
  });
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + 'Z';
  const dir = join(opts.outDir, stamp);
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  try {
    await mkdir(join(dir, 'data'), { recursive: true, mode: 0o700 });
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      database: (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db,
      migrations: await migrationsOf(client),
      tables: {},
      sequences: {},
      attachments: { files: {}, missing: [] },
    };
    for (const table of await tablesOf(client)) {
      const file = `data/${table}.ndjson.gz`;
      const path = join(dir, file);
      const gzip = createGzip();
      const out = createWriteStream(path, { mode: 0o600 });
      const done = pipeline(gzip, out);
      let rows = 0;
      await client.query(`DECLARE backup_cursor NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM ${ident(table)} t`);
      for (;;) {
        const r = await client.query<{ j: string }>(`FETCH ${BATCH} FROM backup_cursor`);
        for (const row of r.rows) gzip.write(`${row.j}\n`);
        rows += r.rows.length;
        if (r.rows.length < BATCH) break;
      }
      await client.query('CLOSE backup_cursor');
      gzip.end();
      await done;
      manifest.tables[table] = { rows, file, sha256: await sha256File(path) };
    }
    const seq = await client.query<{ name: string; value: string | null }>("SELECT sequencename AS name, last_value::text AS value FROM pg_sequences WHERE schemaname = 'public'");
    for (const s of seq.rows) if (s.value !== null) manifest.sequences[s.name] = s.value;
    // 快照中引用的附件（附件表 + 回收站快照）/ attachments referenced by the snapshot (table + recycle-bin snapshots)
    const refs = await client.query<{ org: string; id: string }>(`
      SELECT organization_id::text AS org, id::text AS id FROM attachments
      UNION
      SELECT r.organization_id::text, a->>'id' FROM recycle_bin_items r, jsonb_array_elements(coalesce(r.payload->'attachments', '[]'::jsonb)) a`);
    await client.query('COMMIT');
    for (const { org, id } of refs.rows) {
      if (!UUID.test(org) || !UUID.test(id)) continue;
      const key = `${org}/${id}`;
      const src = join(opts.attachmentsDir, org, id);
      try {
        await mkdir(join(dir, 'attachments', org), { recursive: true, mode: 0o700 });
        const dest = join(dir, 'attachments', org, id);
        await copyFile(src, dest);
        await chmod(dest, 0o600);
        manifest.attachments.files[key] = await sha256File(dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        manifest.attachments.missing.push(key);
      }
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const pruned = await prune(opts.outDir, opts.keep ?? 14);
    return { dir, manifest, pruned };
  } catch (err) {
    // 失败时删除不完整的备份目录 / remove the incomplete backup directory on failure
    await rm(dir, { recursive: true, force: true });
    throw err;
  } finally {
    await client.end().catch(() => undefined);
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/**
 * 只保留最近 keep 份备份（按目录名时间排序；只处理符合命名格式且含清单的目录）。
 * Keep only the newest `keep` backups (by directory name; only well-formed directories with a manifest).
 */
export async function prune(outDir: string, keep: number): Promise<string[]> {
  const names = (await readdir(outDir)).filter((n) => DIR_PATTERN.test(n)).sort();
  const complete: string[] = [];
  for (const n of names) if (await stat(join(outDir, n, 'manifest.json')).then(() => true, () => false)) complete.push(n);
  const remove = complete.slice(0, Math.max(0, complete.length - keep));
  for (const n of remove) await rm(join(outDir, n), { recursive: true, force: true });
  return remove;
}

/**
 * 校验备份目录：清单存在、每个文件的 SHA-256 一致。返回问题列表（空表示通过）。
 * Verify a backup directory: manifest present and every file's SHA-256 matching. Returns problems (empty = OK).
 */
export async function verify(dir: string): Promise<{ manifest: Manifest | null; problems: string[] }> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return { manifest: null, problems: ['manifest.json 缺失或无法解析 / missing or invalid manifest'] };
  }
  const problems: string[] = [];
  if (manifest.version !== MANIFEST_VERSION) problems.push(`不支持的清单版本 ${manifest.version} / unsupported manifest version`);
  for (const [table, t] of Object.entries(manifest.tables)) {
    const actual = await sha256File(join(dir, t.file)).catch(() => null);
    if (actual !== t.sha256) problems.push(`数据文件校验失败：${table} / checksum mismatch`);
  }
  for (const [key, sum] of Object.entries(manifest.attachments.files)) {
    const actual = await sha256File(join(dir, 'attachments', key)).catch(() => null);
    if (actual !== sum) problems.push(`附件校验失败：${key} / attachment checksum mismatch`);
  }
  return { manifest, problems };
}

/** 恢复参数 / restore options */
export interface RestoreOptions {
  dir: string;
  databaseUrl: string;
  attachmentsDir: string;
  /** 目标库已有数据时清空后恢复 / clear a non-empty target first */
  replace?: boolean;
}

/**
 * 从备份目录恢复到目标库与附件目录。任何检查失败都不会修改目标。
 * Restore a backup into the target database and attachment directory. Failed checks leave the target untouched.
 */
export async function restore(opts: RestoreOptions): Promise<{ tables: Record<string, number>; attachments: number }> {
  const { manifest, problems } = await verify(opts.dir);
  if (!manifest || problems.length) throw new Error(`备份校验失败，已中止 / verification failed:\n${problems.join('\n')}`);
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    const target = await migrationsOf(client);
    const same = target.length === manifest.migrations.length && target.every((m, i) => m.name === manifest.migrations[i]!.name && m.checksum === manifest.migrations[i]!.checksum);
    if (!same) throw new Error('目标库迁移与备份不一致，请先把目标库迁移到备份时的版本（prisma migrate deploy）/ migration mismatch');
    const tables = await tablesOf(client);
    const missingTables = Object.keys(manifest.tables).filter((t) => !tables.includes(t));
    if (missingTables.length) throw new Error(`目标库缺少表：${missingTables.join(', ')} / missing tables`);
    let existing = 0;
    for (const t of tables) existing += Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(t)}`)).rows[0]!.n);
    if (existing > 0 && !opts.replace) throw new Error(`目标库已有 ${existing} 行数据；确认覆盖请加 --replace / target is not empty`);

    const counts: Record<string, number> = {};
    await client.query('BEGIN');
    // 仅本事务内关闭触发器与外键检查（快照本身一致）/ triggers and FK checks off for this transaction only
    await client.query("SET LOCAL session_replication_role = 'replica'");
    if (opts.replace) await client.query(`TRUNCATE ${[...tables, 'sessions'].map(ident).join(', ')}`);
    for (const [table, t] of Object.entries(manifest.tables)) {
      const lines = createInterface({ input: createReadStream(join(opts.dir, t.file)).pipe(createGunzip()), crlfDelay: Infinity });
      let batch: string[] = [];
      let n = 0;
      const flush = async () => {
        if (!batch.length) return;
        await client.query(`INSERT INTO ${ident(table)} SELECT * FROM json_populate_recordset(NULL::${ident(table)}, $1::json)`, [`[${batch.join(',')}]`]);
        n += batch.length;
        batch = [];
      };
      for await (const line of lines) {
        if (!line) continue;
        batch.push(line);
        if (batch.length >= BATCH) await flush();
      }
      await flush();
      if (n !== t.rows) throw new Error(`行数不一致：${table} ${n}/${t.rows} / row count mismatch`);
      counts[table] = n;
    }
    for (const [name, value] of Object.entries(manifest.sequences)) await client.query('SELECT setval($1::regclass, $2::bigint)', [ident(name), value]);
    await client.query('COMMIT');

    // 附件文件 / attachment files
    let files = 0;
    for (const key of Object.keys(manifest.attachments.files)) {
      const [org, id] = key.split('/') as [string, string];
      if (!UUID.test(org) || !UUID.test(id)) continue;
      await mkdir(join(opts.attachmentsDir, org), { recursive: true, mode: 0o700 });
      const dest = join(opts.attachmentsDir, org, id);
      const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
      await copyFile(join(opts.dir, 'attachments', key), tmp);
      await chmod(tmp, 0o600);
      await rename(tmp, dest);
      files += 1;
    }
    return { tables: counts, attachments: files };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
