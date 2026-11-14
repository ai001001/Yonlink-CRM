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
export async function nav(page: Page, name: '工作台' | '线索' | '客户' | '商机' | '跟进' | '报价单' | '报表' | '销售预测' | '产品' | '查重合并' | '回收站' | '审计日志' | '用户管理'): Promise<void> {
  await page.getByRole('menu').getByRole('link', { name, exact: true }).click();
}

/**
 * 选择下拉选项并确认已选中（下拉展开动画期间的点击可能被忽略，失败时自动重试）。
 * 不按 Esc：Esc 会同时关闭所在的弹窗；改为当目标选项不在已展开的下拉中时点击字段展开。
 * Pick a select option and confirm it took effect (clicks during the open animation can be ignored; retried).
 * No Escape key: it would also close the surrounding modal; the field is clicked when the option is not showing.
 * @param scope 表单所在的对话框 / dialog containing the field
 * @param label 字段标签 / field label
 * @param option 选项文字 / option text
 */
export async function selectOption(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  const dropdown = page.locator('.ant-select-dropdown:visible');
  const item = dropdown.getByTitle(option, { exact: true });
  await expect(async () => {
    if (!(await item.isVisible())) await scope.getByLabel(label).click();
    await item.click({ timeout: 2000 });
    await expect(scope.getByTitle(option, { exact: true })).toBeVisible({ timeout: 1000 });
    await expect(dropdown).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/**
 * 在列表搜索框中搜索。先等待所有弹窗完全关闭：antd 关闭弹窗时会把焦点还给打开它的按钮，
 * 若在关闭动画期间按 Enter，回车会落在该按钮上而重新打开弹窗（负载高时更容易出现）。
 * Search in a list search box. Waits for every modal to finish closing first: antd returns focus to the
 * button that opened a modal, so an Enter pressed during the close animation re-opens the modal.
 */
export async function searchList(page: Page, placeholder: string, text: string): Promise<void> {
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  const box = page.getByPlaceholder(placeholder);
  await box.fill(text);
  await box.press('Enter');
}
