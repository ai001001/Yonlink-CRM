/**
 * E2E 辅助 / E2E helpers.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD } from './global-setup';

/** 通过界面登录 / Sign in through the UI */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(E2E_EMAIL);
  await page.getByLabel('密码').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page.getByTestId('user-menu')).toBeVisible();
}

/** 点击左侧导航 / Click a side-navigation entry */
export async function nav(page: Page, name: '工作台' | '线索' | '客户' | '商机' | '跟进' | '审计日志' | '用户管理'): Promise<void> {
  await page.getByRole('menu').getByRole('link', { name, exact: true }).click();
}

/**
 * 选择下拉选项并确认已选中（下拉展开动画期间的点击可能被忽略，失败时自动重试）。
 * Pick a select option and confirm it took effect (clicks during the open animation can be ignored; retried).
 * @param scope 表单所在的对话框 / dialog containing the field
 * @param label 字段标签 / field label
 * @param option 选项文字 / option text
 */
export async function selectOption(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Escape');
    await scope.getByLabel(label).click();
    await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click({ timeout: 2000 });
    await expect(scope.getByTitle(option, { exact: true })).toBeVisible({ timeout: 1000 });
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}
