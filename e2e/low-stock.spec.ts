/**
 * 低库存提醒 第三轮：端到端回归（运行定时任务脚本 → 郑经理的通知中心出现演示低库存产品的提醒 → 点击后打开该产品的库存详情；
 * 销售没有低库存提醒）。定时任务脚本连接测试库运行，与服务器上的定时器相同。
 * Low-stock alerts round 3: end-to-end regression; runs the scheduled script against the test database like the
 * server timer does.
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 以当前会话调用接口 / call the API with the current session */
async function api(page: Page, path: string) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.get(path, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('定时任务发出低库存提醒，经理点击后打开产品库存 / low-stock alert opens the product stock', async ({ page }) => {
  test.setTimeout(120_000);
  const out = execFileSync('npx', ['tsx', 'scripts/workflow-sweep.ts'], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: 'utf8' });
  expect(out).toMatch(/低库存提醒完成 \/ low-stock alerts done:/);

  await demoSignIn(page, '郑经理');
  const alerts = (await api(page, '/api/notifications?pageSize=50')).items.filter((n: { type: string }) => n.type === 'LOW_STOCK');
  expect(alerts.length).toBeGreaterThan(0);
  const first = alerts[0] as { title: string; productId: string };
  await page.goto('/notifications');
  const row = page.getByRole('row', { name: new RegExp(first.title.replace(/[()]/g, '\\$&')) }).first();
  await expect(row).toContainText('低库存');
  await expect(row).toContainText('库存已降到再订货水平以下');
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/products\/?\?id=/);
  const sku = /\(([^)]+)\)$/.exec(first.title)![1]!;
  await expect(page.getByTestId('stock-drawer')).toBeVisible();
  await expect(page.locator('.ant-drawer-title')).toContainText(sku);

  // 销售没有低库存提醒：先退出（已登录时登录页会跳回首页）/ sales reps get none: sign out first (the login page redirects signed-in users)
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  await page.request.post('/api/auth/logout', { headers: { Authorization: `Bearer ${token}` } });
  await page.evaluate(() => localStorage.removeItem('yonlink-crm.token'));
  await demoSignIn(page, '王芳');
  expect((await api(page, '/api/notifications?pageSize=50')).items.filter((n: { type: string }) => n.type === 'LOW_STOCK')).toEqual([]);
});
