/**
 * 应收账款报表 第三轮：端到端回归（经理从销售报表进入应收账款 → 汇总、账龄、按客户、明细 → 切换币种 →
 * 点击发票号打开发票详情；销售代表只看到自己负责的）。基于演示数据。
 * Receivables round 3: end-to-end regression on the demo data.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { nav, selectOption } from './helpers';

/** 演示账号一键登录 / demo one-click sign-in */
async function demoSignIn(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('经理查看应收账款并跳转发票 / manager views receivables', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await nav(page, '报表');
  await page.getByRole('link', { name: '应收账款' }).click();
  await expect(page).toHaveURL(/\/reports\/receivables/);
  const report = page.getByTestId('receivables');

  // 人民币：两张逾期发票（部分付款的逾期 90 天以上，未付款的逾期 61–90 天）/ CNY: two overdue invoices
  await expect(report.getByTestId('kpi-outstanding')).toContainText('2 张发票');
  await expect(report.getByTestId('kpi-overdue')).toContainText('2 张发票');
  const aging = report.getByTestId('chart-aging');
  await expect(aging).toContainText('逾期 90 天以上');
  const accounts = report.getByTestId('receivables-accounts');
  await expect(accounts.getByRole('row', { name: /北方重卡配件集团/ })).toBeVisible();
  await expect(accounts.getByRole('row', { name: /东北客车动力维修公司/ })).toBeVisible();
  const invoices = report.getByTestId('receivables-invoices');
  await expect(invoices.getByRole('row', { name: /北方重卡配件集团/ })).toContainText(/逾期 \d+ 天/);

  // 美元：一张未到期 / USD: one invoice not yet due
  await selectOption(page, page.locator('main'), '币种', 'USD');
  await expect(accounts.getByRole('row', { name: /曼谷涡轮专修中心/ })).toBeVisible();
  await expect(report.getByTestId('kpi-overdue')).toContainText('0 张发票');
  await expect(invoices.getByRole('row', { name: /曼谷涡轮专修中心/ })).toContainText('未到期');

  // 点击发票号打开发票详情 / the invoice number opens the invoice
  await invoices.getByRole('link', { name: /^INV-/ }).click();
  await expect(page).toHaveURL(/\/invoices\?id=/);
  await expect(page.getByRole('dialog', { name: /发票详情 · INV-/ })).toContainText('曼谷涡轮专修中心');
});

test('销售代表只看到自己负责的应收 / sales reps see only their own', async ({ page }) => {
  await demoSignIn(page, '陈静');
  await page.goto('/reports/receivables');
  const report = page.getByTestId('receivables');
  await expect(page.getByText('销售代表只统计自己负责的数据。')).toBeVisible();
  await expect(report.getByTestId('kpi-outstanding')).toContainText('0 张发票');
  await expect(page.getByRole('combobox', { name: '负责人' })).toHaveCount(0);
  await selectOption(page, page.locator('main'), '币种', 'USD');
  await expect(report.getByTestId('receivables-accounts').getByRole('row', { name: /曼谷涡轮专修中心/ })).toBeVisible();
  await expect(report.getByTestId('kpi-outstanding')).toContainText('1 张发票');
});

test('经理导出应收账款 CSV；只读用户没有导出按钮 / export CSV; read-only users have no export', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await page.goto('/reports/receivables');
  await expect(page.getByTestId('kpi-outstanding')).toContainText('2 张发票');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导\s*出/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^receivables-CNY-\d{8}\.csv$/);
  const content = (await readFile(await download.path())).toString('utf8');
  const lines = content.replace(/^\uFEFF/, '').trim().split('\r\n');
  expect(lines[0]).toBe('发票号,客户,负责人,币种,开票日期,到期日,发票金额,已收金额,未付余额,逾期天数,账龄');
  expect(lines).toHaveLength(3);
  expect(content).toContain('北方重卡配件集团');
  expect(content).toContain('逾期 90 天以上');
  await expect(page.getByText('已导出 2 条').first()).toBeVisible();

  // 只读用户 / read-only user
  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await demoSignIn(page, '周会计');
  await page.goto('/reports/receivables');
  await expect(page.getByTestId('kpi-outstanding')).toBeVisible();
  await expect(page.getByRole('button', { name: /导\s*出/ })).toHaveCount(0);
});
