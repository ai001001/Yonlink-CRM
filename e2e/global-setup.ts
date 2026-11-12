/**
 * E2E 全局准备：迁移测试库、清空数据、创建 E2E 账号（独立测试数据）。
 * E2E global setup: migrate and wipe the test DB and create the E2E account (isolated test data).
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';

export const E2E_EMAIL = 'e2e-admin@yonlink.test';
export const E2E_PASSWORD = 'E2e-Passw0rd-local';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/\/[\w-]*_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must end with _test');
  const env = { ...process.env, DATABASE_URL: url };
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env });
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('TRUNCATE audit_logs, quote_line_items, quotes, deal_line_items, products, notes, activities, deals, contacts, accounts, leads, sessions, users, organizations CASCADE');
  await client.end();
  execSync('npx tsx prisma/seed.ts', {
    stdio: 'inherit',
    env: { ...env, SEED_ADMIN_EMAIL: E2E_EMAIL, SEED_ADMIN_PASSWORD: E2E_PASSWORD, SEED_ORG_NAME: 'E2E 测试组织' },
  });
  // 演示组织与各角色演示账号（用于一键登录与权限 E2E）/ demo org and per-role demo accounts
  execSync('npx tsx prisma/seed-demo.ts', { stdio: 'inherit', env });
}
