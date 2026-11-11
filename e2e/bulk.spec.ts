/**
 * 批量操作 第三轮：端到端回归（勾选 → 批量改状态 → 批量指派 → 部分失败明细 → 批量完成 → 只读用户不可勾选）。
 * Bulk actions round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 在列表中搜索 / search the list */
async function search(page: Page, placeholder: string, text: string) {
  // 等弹窗完全关闭，避免回车落到打开弹窗的按钮上 / wait for modals to close first
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await page.getByPlaceholder(placeholder).fill(text);
  await page.getByPlaceholder(placeholder).press('Enter');
}

/** 勾选表格全部行（表头复选框）/ select every row via the header checkbox */
async function selectAll(page: Page) {
  await page.locator('thead .ant-checkbox-input').check();
}

test('批量操作：线索、客户、跟进 / bulk actions on leads, accounts and activities', async ({ page }) => {
  await signIn(page);
  for (const n of ['甲', '乙', '丙']) await apiPost(page, '/api/leads', { name: `E2E 批量线索${n}` });

  // 线索：批量改状态 / leads: bulk status
  await nav(page, '线索');
  await search(page, '搜索姓名、公司、邮箱、电话', 'E2E 批量线索');
  await expect(page.getByRole('row', { name: /E2E 批量线索/ })).toHaveCount(3);
  await selectAll(page);
  const bar = page.getByTestId('bulk-bar');
  await expect(bar).toContainText('已选择 3 条');
  await bar.getByLabel('批量修改状态').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('已确认', { exact: true }).click();
  await expect(page.locator('.ant-modal-confirm-title')).toHaveText('确认将选中的 3 条记录改为“已确认”？');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('已处理 3 条').first()).toBeVisible();
  for (const n of ['甲', '乙', '丙']) await expect(page.getByRole('row', { name: new RegExp(`E2E 批量线索${n}`) })).toContainText('已确认');
  await expect(bar).toHaveCount(0);

  // 线索：批量取消分配 / leads: bulk unassign
  await selectAll(page);
  await bar.getByLabel('批量指派负责人').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('未分配', { exact: true }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('已处理 3 条').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 批量线索甲/ })).toContainText('未分配');

  // 客户：批量删除部分失败并列出原因 / accounts: partial failure lists reasons
  const withDeal = await apiPost(page, '/api/accounts', { name: 'E2E 批量客户有商机' });
  await apiPost(page, '/api/deals', { name: 'E2E 批量商机', accountId: withDeal.id });
  await apiPost(page, '/api/accounts', { name: 'E2E 批量客户无商机' });
  await nav(page, '客户');
  await search(page, '搜索客户名称、电话、网站、地址、联系人', 'E2E 批量客户');
  await expect(page.getByRole('row', { name: /E2E 批量客户/ })).toHaveCount(2);
  await selectAll(page);
  await bar.getByRole('button', { name: /批量删除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  const failures = page.getByTestId('bulk-failures');
  await expect(page.locator('.ant-modal-confirm-title')).toHaveText('成功 1 条，失败 1 条');
  await expect(failures).toContainText('E2E 批量客户有商机：存在关联数据，无法完成该操作');
  await page.getByRole('button', { name: /知道了|OK|确\s*定/ }).last().click();
  await expect(page.getByRole('row', { name: /E2E 批量客户无商机/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /E2E 批量客户有商机/ })).toBeVisible();

  // 跟进：批量标记完成 / activities: bulk complete
  for (const n of ['一', '二']) await apiPost(page, '/api/activities', { type: 'TASK', subject: `E2E 批量任务${n}` });
  await nav(page, '跟进');
  await search(page, '搜索主题、内容', 'E2E 批量任务');
  await expect(page.getByRole('row', { name: /E2E 批量任务/ })).toHaveCount(2);
  await selectAll(page);
  await bar.getByRole('button', { name: '批量标记完成' }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('已处理 2 条').first()).toBeVisible();
  // 默认显示未完成，完成后列表为空 / the default view shows pending items only
  await expect(page.getByRole('row', { name: /E2E 批量任务/ })).toHaveCount(0);
  await page.getByText('已完成', { exact: true }).first().click();
  await expect(page.getByRole('row', { name: /E2E 批量任务/ })).toHaveCount(2);
});

test('只读用户没有勾选框与批量操作栏 / read-only users cannot select rows', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '线索');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  await expect(page.locator('.ant-table-selection-column')).toHaveCount(0);
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});
