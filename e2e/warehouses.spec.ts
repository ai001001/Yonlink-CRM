/**
 * 多仓库 第三轮：端到端回归（经理：产品页“仓库”弹窗看到演示仓库与默认总仓 → 新建 E2E 仓库 → 产品库存详情显示各仓库库存 →
 * 从总仓调拨到 E2E 仓库 → 流水显示调拨与仓库）。结束时把调拨数量调回总仓并停用 E2E 仓库，避免影响共用测试库的其他用例。
 * Multi-warehouse round 3: end-to-end regression; moves the stock back and deactivates its warehouse afterwards.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 以当前会话调用接口 / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok(), `${method} ${path}`).toBe(true);
  return res.json();
}

/** 选择包含文字的下拉选项并按结果确认 / pick an option containing the text */
async function pick(page: Page, select: Locator, option: string) {
  const box = select.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await expect(async () => {
    if (!(await box.textContent())?.includes(option)) {
      await select.click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: option }).first().click({ timeout: 2000 });
    }
    await expect(box).toContainText(option, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

test('经理：仓库管理、各仓库库存与调拨 / manager: warehouses, stock by warehouse and transfers', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await page.goto('/products');
  await page.getByTestId('warehouses-open').click();
  const modal = page.getByRole('dialog', { name: '仓库' });
  await expect(modal.getByRole('row', { name: /【演示】上海总仓/ })).toContainText('默认仓库');
  await expect(modal.getByRole('row', { name: /【演示】华南仓/ })).toBeVisible();
  await modal.getByTestId('warehouse-new').click();
  const form = page.getByRole('dialog', { name: '新建仓库' });
  await form.getByLabel('仓库代码').fill('e2e');
  await form.getByLabel('仓库名称').fill('E2E 临时仓');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form).toBeHidden();
  await expect(modal.getByRole('row', { name: /E2E 临时仓/ })).toContainText('E2E');
  await modal.locator('.ant-modal-close').first().click();

  const product = (await api(page, 'GET', '/api/products?pageSize=1')).items[0];
  const e2e = (await api(page, 'GET', '/api/warehouses')).items.find((w: { code: string }) => w.code === 'E2E');
  const sh = (await api(page, 'GET', '/api/warehouses')).items.find((w: { code: string }) => w.code === 'SH');
  try {
    await page.goto(`/products?id=${product.id}`);
    const drawer = page.getByTestId('stock-drawer');
    await expect(drawer.getByTestId('stock-by-warehouse')).toContainText('SH · 【演示】上海总仓');
    const transferForm = drawer.getByTestId('stock-transfer-form');
    await pick(page, transferForm.getByLabel('调出仓库'), 'SH ·');
    await pick(page, transferForm.getByLabel('调入仓库'), 'E2E ·');
    await transferForm.getByLabel('调拨数量').fill('2');
    await transferForm.getByLabel('调拨 调整原因').fill('E2E 调拨');
    await drawer.getByTestId('stock-transfer').click();
    await expect(page.locator('.ant-message')).toContainText('已调拨');
    await expect(drawer.getByTestId('stock-by-warehouse').getByRole('row', { name: /E2E 临时仓/ })).toContainText('2');
    await expect(drawer.getByRole('row', { name: /E2E 调拨/ }).first()).toContainText('仓库调拨');
  } finally {
    // 恢复：调回总仓并停用 E2E 仓库 / restore: move back and deactivate
    await api(page, 'POST', `/api/products/${product.id}/stock/transfer`, { fromWarehouseId: e2e.id, toWarehouseId: sh.id, quantity: '2', note: 'E2E 调回' }).catch(() => undefined);
    await api(page, 'PATCH', `/api/warehouses/${e2e.id}`, { isActive: false });
  }
});
