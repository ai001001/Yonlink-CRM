/**
 * 标签 第三轮：端到端回归（详情中新建并添加标签 → 列表显示与按标签筛选 → 移除 → 批量添加 → 管理标签改名改色删除 → 审计；只读用户只读）。
 * Tags round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

const ACCOUNTS = '搜索客户名称、电话、网站、地址、联系人';
const dropdown = (page: Page) => page.locator('.ant-select-dropdown:visible');

test('标签：添加、筛选、移除、批量、管理 / tags: add, filter, remove, bulk, manage', async ({ page }) => {
  await signIn(page);
  await apiPost(page, '/api/accounts', { name: 'E2E 标签客户甲' });
  await apiPost(page, '/api/accounts', { name: 'E2E 标签客户乙' });

  // 详情中输入新名称新建并添加 / create a tag from the record detail
  await nav(page, '客户');
  await searchList(page, ACCOUNTS, 'E2E 标签客户甲');
  await page.getByRole('button', { name: 'E2E 标签客户甲' }).click();
  const drawer = page.getByRole('dialog', { name: /客户详情/ });
  const editor = drawer.getByTestId('tag-editor');
  // 下拉展开动画期间的点击可能被忽略：按结果重试——已添加则结束；选项还在就再点；下拉已关但未添加则重新打开并输入
  // clicks during the dropdown's opening animation can be ignored, so retry by outcome: done once added; click again
  // while the option shows; reopen and retype if the dropdown closed without adding
  const create = dropdown(page).getByText('新建标签“E2E 重要”');
  await expect(async () => {
    if ((await editor.locator('.ant-tag', { hasText: 'E2E 重要' }).count()) > 0) return;
    if (await create.isVisible()) {
      await create.click({ timeout: 2000 });
    } else {
      await editor.getByText('标签', { exact: true }).click({ timeout: 2000 });
      await page.keyboard.type('E2E 重要');
      await create.click({ timeout: 2000 });
    }
    await expect(editor.locator('.ant-tag', { hasText: 'E2E 重要' })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await closeDrawer(page, drawer);
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('row', { name: /E2E 标签客户甲/ })).toContainText('E2E 重要');

  // 按标签筛选 / filter by tag
  await searchList(page, ACCOUNTS, 'E2E 标签客户');
  await expect(page.getByRole('row', { name: /E2E 标签客户/ })).toHaveCount(2);
  await page.getByLabel('按标签筛选').click();
  await dropdown(page).getByTitle('E2E 重要', { exact: true }).click();
  await expect(page.getByRole('row', { name: /E2E 标签客户/ })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /E2E 标签客户甲/ })).toBeVisible();

  // 移除 / remove
  await page.getByRole('button', { name: 'E2E 标签客户甲' }).click();
  await editor.locator('.ant-tag', { hasText: 'E2E 重要' }).locator('.ant-tag-close-icon').click();
  await expect(editor).not.toContainText('E2E 重要');
  await closeDrawer(page, drawer);
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('row', { name: /E2E 标签客户/ })).toHaveCount(0);
  // 用筛选框自带的清除按钮清空（不展开下拉），并确认没有展开的下拉，避免与批量栏下拉混淆
  // clear via the filter's own clear button (without opening it) and make sure no dropdown stays open
  const tagFilter = page.locator('.ant-select', { has: page.getByLabel('按标签筛选') });
  await tagFilter.hover();
  await tagFilter.locator('.ant-select-clear').click();
  await page.keyboard.press('Escape');
  await expect(dropdown(page)).toHaveCount(0);

  // 批量添加 / bulk add
  await searchList(page, ACCOUNTS, 'E2E 标签客户');
  await expect(page.getByRole('row', { name: /E2E 标签客户/ })).toHaveCount(2);
  await page.getByRole('checkbox', { name: /全选|Select all/ }).or(page.locator('thead .ant-checkbox-input')).first().check({ force: true });
  const bar = page.getByTestId('bulk-bar');
  await expect(bar).toContainText('已选择 2 条');
  await bar.getByLabel('添加标签').click();
  await dropdown(page).getByTitle('E2E 重要', { exact: true }).click();
  await expect(page.locator('.ant-modal-confirm-title')).toHaveText('为选中的 2 条记录添加标签“E2E 重要”？');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('已处理 2 条').first()).toBeVisible();
  for (const n of ['甲', '乙']) await expect(page.getByRole('row', { name: new RegExp(`E2E 标签客户${n}`) })).toContainText('E2E 重要');

  // 管理标签：改名、删除 / manage: rename, delete
  await page.getByRole('button', { name: '管理标签' }).click();
  const manager = page.getByRole('dialog', { name: '管理标签' });
  await expect(manager).toContainText('客户 2');
  const nameInput = manager.getByLabel('标签名称 E2E 重要');
  await nameInput.fill('E2E 关键');
  await nameInput.blur();
  await expect(manager.getByLabel('标签名称 E2E 关键')).toBeVisible();
  await manager.getByRole('button', { name: /删\s*除/ }).first().click();
  await expect(page.locator('.ant-popover:visible')).toContainText('删除标签“E2E 关键”？将从 2 条记录上移除');
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(manager).toContainText('暂无标签');
  await manager.getByRole('button', { name: 'Close' }).or(manager.locator('.ant-modal-close')).first().click();
  for (const n of ['甲', '乙']) await expect(page.getByRole('row', { name: new RegExp(`E2E 标签客户${n}`) }).locator('.ant-tag')).toHaveCount(0);

  // 审计 / audit
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table:visible').first()).toContainText('标签');
});

test('只读用户：可看到演示标签，不能添加或管理 / read-only users only view tags', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '客户');
  await page.getByLabel('按标签筛选').click();
  await dropdown(page).getByTitle('重点客户', { exact: true }).click();
  const first = page.locator('tbody tr.ant-table-row').first();
  await expect(first).toContainText('重点客户');
  await expect(page.getByRole('button', { name: '管理标签' })).toHaveCount(0);
  await first.locator('td').getByRole('button').first().click();
  const editor = page.getByRole('dialog', { name: /客户详情/ }).getByTestId('tag-editor');
  await expect(editor).toContainText('重点客户');
  await expect(editor.getByText('标签', { exact: true })).toHaveCount(0);
  await expect(editor.locator('.ant-tag-close-icon')).toHaveCount(0);
});
