/**
 * 产品库存 第三轮：端到端回归（经理：产品列表显示库存列与低库存/缺货筛选 → 打开库存抽屉看到期初、收货、发货流水 →
 * 手工增加 5 并填写原因，库存与流水更新；只读用户：可查看库存流水，不能调整）。基于演示数据。
 * Product stock round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav } from './helpers';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('经理：库存筛选、流水与手工调整 / manager: stock filters, movements and adjustment', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await nav(page, '产品');
  const filter = page.getByTestId('stock-filter');
  await expect(filter).toContainText(/低库存（[1-9]\d*）/);
  await filter.getByText(/低库存（/).click();
  const rows = page.locator('tr.ant-table-row');
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) await expect(row.getByTestId('stock-quantity')).toContainText(/低库存|缺货/);
  await filter.getByText(/缺货（/).click();
  await expect(rows.first().getByTestId('stock-quantity')).toContainText('缺货');
  await filter.getByText('全部库存').click();

  // 一个有发货记录的产品：期初、收货或发货流水 / a product with history
  const row = rows.filter({ hasText: 'DT-CHRA-HD-CN' }).first();
  await row.getByRole('button', { name: '库存', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /库存 · DT-CHRA-HD-CN/ });
  await expect(drawer.getByText('期初库存').first()).toBeVisible();
  const before = Number((await drawer.getByTestId('stock-quantity').first().innerText()).split(' ')[0]);
  await drawer.getByLabel('数量', { exact: true }).fill('5');
  await drawer.getByLabel('调整原因', { exact: true }).fill('E2E 退货入库');
  await drawer.getByTestId('stock-adjust').click();
  await expect(page.getByText('库存已调整')).toBeVisible();
  await expect(drawer.getByTestId('stock-quantity').first()).toContainText(String(before + 5));
  const first = drawer.locator('tr.ant-table-row').first();
  await expect(first).toContainText('手工调整');
  await expect(first).toContainText('+5');
  await expect(first).toContainText('E2E 退货入库');
  await expect(first).toContainText('郑经理');
});

test('只读用户：可查看库存流水，不能调整 / read-only users view stock only', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '产品');
  await page.locator('tr.ant-table-row').first().getByRole('button', { name: '库存', exact: true }).click();
  const drawer = page.getByTestId('stock-drawer');
  await expect(drawer.locator('tr.ant-table-row').first()).toBeVisible();
  await expect(drawer.getByTestId('stock-adjust')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(0);
});
