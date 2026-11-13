/**
 * 每个测试文件加载前：把 DATABASE_URL 指向独立测试库。
 * Before each test file: point DATABASE_URL at the dedicated test database.
 */
import 'dotenv/config';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/[\w-]*_test(\?|$)/.test(url)) {
  throw new Error('TEST_DATABASE_URL must point at a database whose name ends with _test');
}
process.env.DATABASE_URL = url;

// 附件写入系统临时目录下的测试专用目录 / attachments go to a test-only directory under the OS temp dir
if (!process.env.ATTACHMENTS_DIR) {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.ATTACHMENTS_DIR = join(tmpdir(), 'yonlink-test-attachments');
}
