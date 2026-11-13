/**
 * 附件文件存储（本地磁盘）。路径为 <根目录>/<组织 ID>/<附件 ID>，两段都必须是 UUID（不使用用户提供的文件名，杜绝路径注入），
 * 按组织隔离。写入先写临时文件再原子重命名。根目录来自 ATTACHMENTS_DIR；生产环境未配置时直接报错，开发/测试默认 .data/attachments。
 * Attachment file storage on local disk at <root>/<organization id>/<attachment id>; both segments must be UUIDs (user
 * file names are never used, so no path injection) and files are isolated per organization. Writes go to a temp file
 * and are renamed atomically. The root is ATTACHMENTS_DIR; production fails fast without it; dev/test default to
 * .data/attachments.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApiError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 附件根目录。
 * Attachment root directory.
 */
export function attachmentsRoot(): string {
  const dir = process.env.ATTACHMENTS_DIR;
  // 附件目录在运行时由配置决定，不参与构建期文件追踪 / the directory is runtime configuration, excluded from build tracing
  if (dir) return resolve(/* turbopackIgnore: true */ dir);
  if (process.env.NODE_ENV === 'production') throw new ApiError(500, 'INTERNAL_ERROR', 'ATTACHMENTS_DIR is not configured');
  return resolve(/* turbopackIgnore: true */ '.data/attachments');
}

/**
 * 计算文件路径（校验两段均为 UUID）。
 * File path for an attachment (both segments must be UUIDs).
 */
function pathOf(organizationId: string, id: string): { dir: string; file: string } {
  if (!UUID.test(organizationId) || !UUID.test(id)) throw new ApiError(500, 'INTERNAL_ERROR', 'Invalid storage key');
  const dir = join(/* turbopackIgnore: true */ attachmentsRoot(), organizationId);
  return { dir, file: join(/* turbopackIgnore: true */ dir, id) };
}

/**
 * 写入文件（临时文件 + 原子重命名；目录权限 700，文件 600）。
 * Write a file (temp file + atomic rename; directory mode 700, file mode 600).
 */
export async function saveFile(organizationId: string, id: string, data: Uint8Array): Promise<void> {
  const { dir, file } = pathOf(organizationId, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}

/**
 * 读取文件；不存在时 404。
 * Read a file; 404 when missing.
 */
export async function loadFile(organizationId: string, id: string): Promise<Buffer> {
  try {
    return await readFile(/* turbopackIgnore: true */ pathOf(organizationId, id).file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'NOT_FOUND', 'File is missing', { file: ['missing'] });
    throw err;
  }
}

/**
 * 删除文件（不存在时忽略）。
 * Delete a file (ignored when missing).
 */
export async function removeFile(organizationId: string, id: string): Promise<void> {
  await rm(pathOf(organizationId, id).file, { force: true });
}

/**
 * 删除组织的全部附件文件（演示数据重置使用）。
 * Delete all attachment files of an organization (used by the demo reset).
 */
export async function removeOrganizationFiles(organizationId: string): Promise<void> {
  if (!UUID.test(organizationId)) throw new ApiError(500, 'INTERNAL_ERROR', 'Invalid storage key');
  await rm(join(/* turbopackIgnore: true */ attachmentsRoot(), organizationId), { recursive: true, force: true });
}
