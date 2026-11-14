/**
 * 保存的视图 第三轮：端到端回归（另存为视图并设为默认 → 重新打开自动套用 → 切换全部记录与视图 → 更新视图 → 共享 → 删除；
 * 只读用户可保存私有视图、不能共享）。
 * Saved views round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, searchList, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

const SEARCH = '搜索姓名、公司、邮箱、电话';
const dropdown = (page: Page) => page.locator('.ant-select-dropdown:visible');

/**
 * 选择列表区域（main）中的下拉选项并等待下拉关闭；限定在 main 内，避免匹配到预渲染的表单弹窗中的同名字段。
 * Pick an option of a list-area (main) select and wait for it to close; scoped to main so pre-rendered form
 * modals with the same field label are not matched.
 */
async function pick(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('main').getByLabel(label, { exact: true }).click();
  await dropdown(page).getByTitle(option, { exact: true }).click();
  await expect(dropdown(page)).toHaveCount(0);
}

test('视图：保存、默认自动套用、切换、更新、共享、删除 / views end to end', async ({ page }) => {
  await signIn(page);
  for (const n of ['甲', '乙']) await apiPost(page, '/api/leads', { name: `E2E 视图线索${n}` });
  await nav(page, '线索');

  // 设置筛选并另存为默认视图 / filter and save as the default view
  await searchList(page, SEARCH, 'E2E 视图线索');
  await pick(page, '线索状态', '新线索');
  await expect(page.getByRole('row', { name: /E2E 视图线索/ })).toHaveCount(2);
  await page.getByRole('button', { name: '另存为视图' }).click();
  const dialog = page.getByRole('dialog', { name: '另存为视图' });
  await dialog.getByLabel('视图名称').fill('E2E 新线索');
  await dialog.getByText('设为我的默认视图').click();
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  const viewSelect = page.getByTestId('saved-views');
  await expect(viewSelect).toContainText('E2E 新线索');

  // 重新打开页面：自动套用默认视图 / reopening applies the default view
  await page.reload();
  await expect(page.getByPlaceholder(SEARCH)).toHaveValue('E2E 视图线索');
  await expect(page.getByTestId('saved-views')).toContainText('E2E 新线索');
  await expect(page.getByRole('main').locator('.ant-select', { has: page.getByLabel('线索状态', { exact: true }) })).toContainText('新线索');
  await expect(page.getByRole('row', { name: /E2E 视图线索/ })).toHaveCount(2);

  // 切到全部记录：筛选清空；再切回视图 / all records clears filters; switch back
  await pick(page, '视图', '全部记录');
  await expect(page.getByPlaceholder(SEARCH)).toHaveValue('');
  await pick(page, '视图', 'E2E 新线索');
  await expect(page.getByPlaceholder(SEARCH)).toHaveValue('E2E 视图线索');

  // 修改筛选后更新视图 / update the view after changing filters
  await pick(page, '线索状态', '已联系');
  await expect(page.getByRole('row', { name: /E2E 视图线索/ })).toHaveCount(0);
  await page.getByRole('button', { name: '更新视图' }).click();
  await expect(page.getByText('视图已更新').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '更新视图' })).toHaveCount(0);

  // 共享、取消默认、删除 / share, clear default, delete
  await page.getByRole('button', { name: '视图操作' }).click();
  await page.getByRole('menuitem', { name: '共享给全组织' }).click();
  await expect(page.getByText('视图已保存').first()).toBeVisible();
  await page.getByRole('button', { name: '视图操作' }).click();
  await expect(page.getByRole('menuitem', { name: '取消共享' })).toBeVisible();
  await page.getByRole('menuitem', { name: '删除视图' }).click();
  await expect(page.locator('.ant-modal-confirm-title')).toHaveText('删除视图“E2E 新线索”？只删除视图，不影响任何记录。');
  await page.locator('.ant-modal-confirm').getByRole('button', { name: /删\s*除/ }).click();
  await expect(page.getByTestId('saved-views')).toContainText('全部记录');
  await page.reload();
  await expect(page.getByPlaceholder(SEARCH)).toHaveValue('');

  // 审计：共享视图的变更 / audit of shared-view changes
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table:visible').first()).toContainText('视图');
});

test('只读用户可保存私有视图，不能共享 / read-only users save private views only', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '客户');
  await pick(page, '行业', '制造业');
  await page.getByRole('button', { name: '另存为视图' }).click();
  const dialog = page.getByRole('dialog', { name: '另存为视图' });
  await expect(dialog.getByText('共享给全组织')).toHaveCount(0);
  await dialog.getByLabel('视图名称').fill('E2E 只读制造业');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByTestId('saved-views')).toContainText('E2E 只读制造业');
  await pick(page, '视图', '全部记录');
  await pick(page, '视图', 'E2E 只读制造业');
  await expect(page.getByRole('main').locator('.ant-select', { has: page.getByLabel('行业', { exact: true }) })).toContainText('制造业');
  await page.getByRole('button', { name: '视图操作' }).click();
  await expect(page.getByRole('menuitem', { name: '共享给全组织' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '删除视图' })).toBeVisible();
});
