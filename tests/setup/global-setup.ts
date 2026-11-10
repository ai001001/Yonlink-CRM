/**
 * 全局准备：对测试库执行全部 migration。
 * Global setup: apply all migrations to the test database.
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';

export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/\/[\w-]*_test(\?|$)/.test(url)) {
    throw new Error('TEST_DATABASE_URL must point at a database whose name ends with _test');
  }
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
