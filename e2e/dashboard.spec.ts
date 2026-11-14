/**
 * 工作台 第三轮：端到端回归（统计随业务操作变化、待办完成、全局搜索与详情跳转）。
 * Dashboard round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, selectOption, signIn } from './helpers';

const SAVE = /保\s*存/;

/** 读取 KPI 数值 / Read a KPI value */
async function kpi(page: Page, id: string): Promise<number> {
  const text = await page.getByTestId(id).locator('.ant-statistic-content-value').innerText();
  return Number(text.replace(/,/g, ''));
}

test('工作台统计与全局搜索 / dashboard figures and global search', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText(/你好，/)).toBeVisible();
  await expect(page.getByTestId('kpi-accounts')).toBeVisible();
  const before = { accounts: await kpi(page, 'kpi-accounts'), leads: await kpi(page, 'kpi-leads'), deals: await kpi(page, 'kpi-deals') };

  // 业务操作：新增客户、线索、商机、待办 / create account, lead, deal, to-do
  await nav(page, '客户');
  await page.getByRole('button', { name: '新增客户' }).click();
  let dialog = page.getByRole('dialog', { name: '新增客户' });
  await dialog.getByLabel('客户名称').fill('E2E 工作台客户');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 工作台客户/ })).toBeVisible();

  await nav(page, '线索');
  await page.getByRole('button', { name: '新增线索' }).click();
  dialog = page.getByRole('dialog', { name: '新增线索' });
  await dialog.getByLabel('姓名').fill('E2E 工作台线索');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 工作台线索/ })).toBeVisible();

  await nav(page, '商机');
  await page.getByRole('button', { name: '新增商机' }).click();
  dialog = page.getByRole('dialog', { name: '新增商机' });
  await dialog.getByLabel('商机名称').fill('E2E 工作台商机');
  await dialog.getByLabel('关联客户').click();
  await dialog.getByLabel('关联客户').fill('工作台客户');
  await page.getByTitle('E2E 工作台客户').click();
  await dialog.getByLabel('商机金额').fill('7000000');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 工作台商机/ })).toBeVisible();

  await nav(page, '跟进');
  await page.getByRole('button', { name: '新增跟进' }).click();
  dialog = page.getByRole('dialog', { name: '新增跟进' });
  await selectOption(page, dialog, '类型', '任务');
  await dialog.getByLabel('主题').fill('E2E 工作台待办');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 工作台待办/ })).toBeVisible();

  // 工作台数字同步变化 / dashboard figures updated
  await nav(page, '工作台');
  await expect.poll(() => kpi(page, 'kpi-accounts')).toBe(before.accounts + 1);
  expect(await kpi(page, 'kpi-leads')).toBe(before.leads + 1);
  expect(await kpi(page, 'kpi-deals')).toBe(before.deals + 1);
  await expect(page.getByTestId('amount-open')).toContainText('¥7,000,000.00');
  await expect(page.getByTestId('stage-table')).toContainText('资格确认');
  await expect(page.getByTestId('recent-activities')).toContainText('E2E 工作台待办');
  const todos = page.getByTestId('my-todos');
  await expect(todos).toContainText('E2E 工作台待办');

  // 在工作台完成待办 / complete a to-do from the dashboard
  await todos.getByRole('checkbox', { name: '标记完成 E2E 工作台待办' }).click();
  await expect(todos).not.toContainText('E2E 工作台待办');
  await expect(page.getByTestId('recent-activities')).toContainText('已完成');

  // 全局搜索并跳转详情 / global search and open detail
  const searchBox = page.getByPlaceholder('搜索线索、客户、商机');
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await searchBox.fill('E2E 工作台');
  await searchBox.press('Enter');
  const results = page.getByTestId('search-results');
  await expect(results).toContainText('“E2E 工作台” 的搜索结果');
  await expect(results.getByRole('link', { name: 'E2E 工作台线索' })).toBeVisible();
  await expect(results.getByRole('link', { name: 'E2E 工作台客户' })).toBeVisible();
  await results.getByRole('link', { name: 'E2E 工作台商机' }).click();
  await expect(page.getByRole('dialog', { name: /商机详情 · E2E 工作台商机/ })).toBeVisible();
  const dealDrawer = page.getByRole('dialog', { name: /商机详情/ });
  await expect(dealDrawer).toContainText('¥7,000,000.00');
  // 抽屉打开时焦点被锁定在抽屉内，先关闭再使用顶部搜索 / focus is trapped in the open drawer; close it first
  await closeDrawer(page, dealDrawer);
  await expect(dealDrawer).toBeHidden();

  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await searchBox.fill('不存在的关键字XYZ');
  await searchBox.press('Enter');
  await expect(page.getByText('没有找到匹配的记录')).toBeVisible();
});
