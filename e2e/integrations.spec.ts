/**
 * Webhook 与 API 密钥 第三轮：端到端回归（管理员：设置 › 集成 → 新建 API 密钥只显示一次 → 用密钥调用接口 200 →
 * 吊销后 401；新建 Webhook（保留域名，不实际发送）→ 签名密钥只显示一次 → 停用 → 投递记录为空）。
 * Webhooks and API keys round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { nav, signIn } from './helpers';

const SAVE = /保\s*存/;

test('管理员：API 密钥与 Webhook / admin: API keys and webhooks', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await nav(page, '集成');

  // API 密钥 / API key
  const keys = page.getByTestId('api-keys');
  await keys.getByTestId('api-key-new').click();
  const dialog = page.getByRole('dialog', { name: '新建 API 密钥' });
  await dialog.getByLabel('名称').fill('E2E 集成');
  await dialog.getByLabel('以该用户身份').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await dialog.getByRole('button', { name: SAVE }).click();
  const secretBox = page.getByRole('dialog', { name: 'API 密钥已创建' });
  const key = (await secretBox.getByTestId('secret-value').innerText()).trim();
  expect(key).toMatch(/^ylk_[A-Za-z0-9_-]{43}$/);
  // 按结果确认弹窗已关闭（弹出动画期间的点击可能落空）/ confirm by outcome that the dialog closed (clicks during its animation can miss)
  await expect(async () => {
    if (await secretBox.isVisible()) await secretBox.getByRole('button', { name: '我已保存' }).click({ timeout: 2000 });
    await expect(secretBox).toBeHidden({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  const row = keys.locator('tr.ant-table-row').filter({ hasText: 'E2E 集成' });
  await expect(row).toContainText('有效');
  await expect(row).toContainText(key.slice(0, 12));
  expect((await page.request.get('/api/leads', { headers: { Authorization: `Bearer ${key}` } })).status()).toBe(200);
  await row.getByRole('button', { name: /吊\s*销/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).last().click();
  await expect(row).toContainText('已吊销');
  expect((await page.request.get('/api/leads', { headers: { Authorization: `Bearer ${key}` } })).status()).toBe(401);

  // Webhook（保留域名，不点测试，不会发出请求）/ webhook on a reserved domain; no request is sent
  const hooks = page.getByTestId('webhooks');
  await hooks.getByTestId('webhook-new').click();
  const hookDialog = page.getByRole('dialog', { name: '新建 Webhook' });
  await hookDialog.getByLabel('名称').fill('E2E 接收端');
  await hookDialog.getByLabel('地址').fill('https://example.com/e2e-hook');
  await hookDialog.getByRole('button', { name: SAVE }).click();
  const secretDialog = page.getByRole('dialog', { name: '签名密钥' });
  await expect(secretDialog.getByTestId('secret-value')).toHaveText(/^whsec_/);
  await secretDialog.getByRole('button', { name: '我已保存' }).click();
  const hookRow = hooks.locator('tr.ant-table-row').filter({ hasText: 'E2E 接收端' });
  await expect(hookRow).toContainText('https://example.com/e2e-hook');
  await hookRow.getByRole('switch').click();
  await expect(hookRow.getByRole('switch')).not.toBeChecked();
  await hookRow.getByRole('button', { name: '投递记录' }).click();
  await expect(page.getByTestId('webhook-deliveries')).toContainText('暂无投递记录');
});
