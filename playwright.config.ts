/**
 * Playwright E2E 配置：生产构建 + 独立测试库。
 * Playwright E2E config: production build against the dedicated test database.
 */
import 'dotenv/config';
import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    // 本机 ARM64 Ubuntu 使用系统 Chromium；CI 使用 Playwright 自带浏览器
    // system Chromium on the ARM64 Ubuntu server; bundled browser in CI
    launchOptions: { executablePath: process.env.CI ? undefined : (process.env.CHROMIUM_PATH ?? '/usr/bin/chromium') },
  },
  webServer: {
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? '', NODE_ENV: 'production', DEMO_LOGIN_ENABLED: '1' },
  },
});
