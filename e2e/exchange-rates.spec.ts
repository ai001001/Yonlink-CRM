/**
 * 汇率 第三轮：端到端回归（管理员录入汇率 → 当前汇率与历史 → 销售报表本币汇总 → 删除；经理查看应收账款本币汇总与
 * 美元发票的汇率快照；只读用户只能查看）。
 * Exchange rates round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, selectOption, signIn } from './helpers';

/** 演示账号一键登录 / demo one-click sign-in */
async function demoSignIn(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('管理员录入与删除汇率，报表显示本币汇总 / admin manages rates', async ({ page }) => {
  await signIn(page);
  await nav(page, '汇率');
  const current = page.getByTestId('rates-current');
  await expect(current).toContainText('1 USD = ? CNY');
  await page.getByLabel('汇率（CNY）').fill('7.25');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('保存成功').first()).toBeVisible();
  await expect(current).toContainText('7.25');
  const row = page.getByTestId('rates-history').getByRole('row', { name: /USD/ });
  await expect(row).toContainText('7.25');

  await nav(page, '报表');
  await expect(page.getByTestId('reports-base')).toContainText('全部币种折合 CNY（按当前汇率）');

  await nav(page, '汇率');
  await page.getByTestId('rates-history').getByRole('row', { name: /USD/ }).getByRole('button', { name: /删\s*除/ }).click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByTestId('rates-history')).toContainText('尚未录入汇率');
});

test('经理查看本币汇总与发票汇率快照；只读用户只能查看汇率 / base totals, snapshot, read-only', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await page.goto('/reports/receivables');
  await expect(page.getByTestId('receivables-base')).toContainText('全部币种折合 CNY');
  await expect(page.getByTestId('receivables-base')).not.toContainText('缺少汇率');
  await selectOption(page, page.locator('main'), '币种', 'USD');
  await page.getByTestId('receivables-invoices').getByRole('link', { name: /^INV-/ }).click();
  await expect(page.getByTestId('invoice-rate')).toContainText('1 USD = 7.18 CNY');
  await closeDrawer(page, page.getByRole('dialog', { name: /发票详情/ }));

  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await demoSignIn(page, '周会计');
  await nav(page, '汇率');
  await expect(page.getByTestId('rates-current')).toContainText('7.18');
  await expect(page.getByText('只有管理员可以录入和删除汇率。')).toBeVisible();
  await expect(page.getByLabel('汇率（CNY）')).toHaveCount(0);
});
