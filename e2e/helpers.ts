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

/**
 * 点击左侧导航。分组可以折叠：目标不可见时先点“全部展开”。菜单含嵌套子菜单，只在最外层菜单中查找。
 * Click a side-navigation entry. Groups are collapsible, so expand all first when the entry is hidden; submenus
 * nest menus, so look inside the root menu only.
 */
export async function nav(page: Page, name: '工作台' | '线索' | '市场活动' | '客户' | '联系人' | '商机' | '跟进' | '服务工单' | '知识库' | '报价单' | '销售订单' | '发票' | '报表' | '销售预测' | '产品' | '汇率' | '查重合并' | '回收站' | '审计日志' | '用户管理'): Promise<void> {
  const link = sideMenu(page).getByRole('link', { name, exact: true });
  if (!(await link.isVisible())) await page.getByTestId('sider-toolbar').getByRole('button', { name: '全部展开' }).click();
  await link.click();
}

/** 左侧导航的最外层菜单 / the root menu of the side navigation */
export function sideMenu(page: Page): Locator {
  return page.getByTestId('sider').locator('ul.ant-menu-root');
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
  // 抽屉同理：关闭动画结束后焦点回到列表中的记录名按钮，回车会重新打开详情 / drawers too: focus returns to the record-name button
  await expect(page.locator('.ant-drawer-content-wrapper:visible')).toHaveCount(0);
  const box = page.getByPlaceholder(placeholder);
  await box.fill(text);
  await box.press('Enter');
}

/**
 * 关闭抽屉，按结果确认：先把鼠标移开并等顶部提示条全部消失（提示条可能盖住关闭按钮，鼠标悬停会暂停它自动
 * 消失）；点击关闭后确认抽屉已隐藏，未隐藏则重试（抽屉打开动画期间的点击可能被忽略）。所有 E2E 关闭抽屉都应使用本函数。
 * Close a drawer and confirm the outcome: move the mouse away and wait for the top toasts to disappear (they can cover
 * the close button, and hovering pauses their auto-dismiss); after clicking close, confirm the drawer is hidden and
 * retry otherwise (a click during the opening animation can be ignored). Every E2E test should use this helper.
 * @param drawer 抽屉 / the drawer
 */
export async function closeDrawer(page: Page, drawer: Locator): Promise<void> {
  // 先把鼠标移到左上角空白处，避免悬停在提示条上 / move the mouse to the empty top-left corner first
  await page.mouse.move(1, 1);
  await expect(page.locator('.ant-message-notice')).toHaveCount(0, { timeout: 15000 });
  await expect(async () => {
    if (await drawer.isVisible()) await drawer.getByRole('button', { name: '关闭' }).first().click({ timeout: 2000 });
    await expect(drawer).toBeHidden({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
}

/**
 * 在可搜索的记录选择框（关联客户、线索、商机等）中搜索并选择一条记录，按结果重试：记录已显示在选择框中则结束；
 * 否则（重新）打开、输入搜索词并点击选项。下拉展开动画期间的点击可能被忽略，按结果判断比按下拉状态判断可靠。
 * Search and pick a record in a searchable record select (account, lead, deal …), retrying by outcome: done once
 * the record shows in the select; otherwise (re)open, type the search and click the option. Clicks during the
 * dropdown's opening animation can be ignored; judging by the outcome is more reliable than by dropdown state.
 * @param scope 表单所在的对话框 / dialog containing the field
 * @param label 字段标签 / field label
 * @param search 搜索词 / search text
 * @param title 选项文字（完整匹配）/ option text (exact)
 */
export async function pickRecord(page: Page, scope: Locator, label: string, search: string, title: string): Promise<void> {
  const picked = scope.getByTitle(title, { exact: true });
  const option = page.locator('.ant-select-dropdown:visible').getByTitle(title, { exact: true });
  await expect(async () => {
    if (await picked.isVisible()) return;
    if (!(await option.isVisible())) {
      await scope.getByLabel(label).click({ timeout: 2000 });
      await scope.getByLabel(label).fill(search, { timeout: 2000 });
    }
    await option.click({ timeout: 2000 });
    await expect(picked).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
}
