/**
 * 英文界面 第三轮：端到端回归（登录页切换英文 → 英文表单登录 → 导航、列表、弹窗、组件库文字为英文 → 切回中文；无水合错误；语言在刷新后保持）。
 * English UI round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD } from './global-setup';

test('切换英文界面并切回中文 / switch to English and back', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /hydrat|did not match|server rendered/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // 登录页：默认中文，切换英文 / login page: Chinese by default, switch to English
  await page.goto('/login');
  await expect(page.getByText('登录永联CRM')).toBeVisible();
  await page.getByTestId('language-switch').getByText('English').click();
  await expect(page.getByText('Sign in to Yonlink CRM')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page).toHaveTitle('Yonlink CRM | Yonlink-CRM');
  await expect(page.getByText('Demo accounts (click “Sign in”, no password needed)')).toBeVisible();

  // 英文表单登录 / sign in with the English form
  await page.getByLabel('Email').fill(E2E_EMAIL);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: /^Sign\s*in$/ }).click();
  await expect(page.getByTestId('user-menu')).toBeVisible();
  const menu = page.getByRole('menu');
  for (const name of ['Dashboard', 'Leads', 'Accounts', 'Deals', 'Activities', 'Quotes', 'Reports', 'Products', 'Recycle bin', 'Audit log', 'Users']) {
    await expect(menu.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('current-role')).toHaveText('Administrator');

  // 列表与弹窗 / list and modal
  await menu.getByRole('link', { name: 'Leads', exact: true }).click();
  await expect(page.getByPlaceholder('Search name, company, email, phone')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Lead status' })).toBeVisible();
  await page.getByRole('button', { name: 'New lead' }).click();
  const dialog = page.getByRole('dialog', { name: 'New lead' });
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('E2E English lead');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E English lead/ })).toContainText('New');

  // 组件库文字（日期选择）为英文 / component library texts are English
  await menu.getByRole('link', { name: 'Deals', exact: true }).click();
  await page.getByRole('button', { name: 'New deal' }).click();
  const deal = page.getByRole('dialog', { name: 'New deal' });
  await expect(deal.getByPlaceholder('Select date')).toBeVisible();
  await deal.getByRole('button', { name: 'Cancel' }).click();

  // 刷新后保持英文 / English survives a reload
  await page.reload();
  await expect(page.getByRole('menu').getByRole('link', { name: 'Deals', exact: true })).toBeVisible();

  // 切回中文 / back to Chinese
  await page.getByTestId('language-switch').getByText('中文').click();
  await expect(page.getByRole('menu').getByRole('link', { name: '商机', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  expect(errors).toEqual([]);
});
