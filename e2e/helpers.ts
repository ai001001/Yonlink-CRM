/**
 * E2E 辅助 / E2E helpers.
 */
import { expect, type Page } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD } from './global-setup';

/** 通过界面登录 / Sign in through the UI */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(E2E_EMAIL);
  await page.getByLabel('密码').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page.getByTestId('user-menu')).toBeVisible();
}

/** 点击左侧导航 / Click a side-navigation entry */
export async function nav(page: Page, name: '工作台' | '线索' | '客户' | '商机' | '跟进' | '审计日志'): Promise<void> {
  await page.getByRole('menu').getByRole('link', { name, exact: true }).click();
}
