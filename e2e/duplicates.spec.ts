/**
 * 查重合并 第三轮：端到端回归（查找重复组 → 合并时逐字段选择 → 跳转主记录核对字段与备注 → 重复组消失、被合并记录进入回收站 → 审计；销售代表只能查看）。
 * Deduplication round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('查找并合并重复线索 / find and merge duplicate leads', async ({ page }) => {
  await signIn(page);
  await apiPost(page, '/api/leads', { name: 'E2E 查重甲', email: 'e2e-dupe@example.com' });
  const dup = await apiPost(page, '/api/leads', { name: 'E2E 查重甲（重复）', email: 'E2E-DUPE@example.com', company: 'E2E 查重公司' });
  await apiPost(page, '/api/notes', { leadId: dup.id, content: '重复记录上的备注' });

  await nav(page, '查重合并');
  const group = page.getByTestId('duplicate-group').filter({ hasText: 'E2E 查重甲（重复）' });
  await expect(group).toContainText('邮箱相同');
  await expect(group).toContainText('备注 1');
  await group.getByRole('button', { name: /合\s*并/ }).click();

  // 主记录默认为最早创建的；公司选重复记录的值 / the oldest is the default master; take the company from the duplicate
  const dialog = page.getByRole('dialog', { name: '合并重复记录' });
  const table = dialog.getByTestId('merge-table');
  await expect(table.getByRole('radio', { name: '主记录 E2E 查重甲', exact: true })).toBeChecked();
  const companyRow = table.getByRole('row', { name: /^公司/ });
  await expect(companyRow.getByRole('radio', { name: 'E2E 查重公司' })).toBeChecked();
  await table.getByRole('row', { name: /^姓名/ }).getByRole('radio', { name: 'E2E 查重甲（重复）' }).check();
  await dialog.getByRole('button', { name: '合并 1 条到主记录' }).click();
  const note = page.locator('.ant-notification-notice').filter({ hasText: '已合并 1 条记录' });
  await expect(note).toBeVisible();
  await expect(group).toHaveCount(0);

  // 主记录：字段与转移来的备注 / master: fields and moved note
  await note.getByRole('link', { name: '查看主记录' }).click();
  const drawer = page.getByRole('dialog', { name: /线索详情/ });
  await expect(drawer).toContainText('E2E 查重甲（重复）');
  await expect(drawer).toContainText('E2E 查重公司');
  await expect(drawer).toContainText('e2e-dupe@example.com');
  await expect(drawer).toContainText('重复记录上的备注');
  await closeDrawer(page, drawer);
  await expect(drawer).toBeHidden();

  // 回收站与审计 / recycle bin and audit
  await nav(page, '回收站');
  await expect(page.getByRole('row', { name: /E2E 查重甲（重复）/ })).toBeVisible();
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table:visible').first()).toContainText('线索 · 合并');
});

test('销售代表只能查看重复记录，不能合并 / sales reps can only view', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 王芳' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('销售代表');
  await page.getByRole('menu').getByRole('link', { name: '查重合并', exact: true }).click();
  await expect(page.getByText('只有管理员和销售经理可以合并。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /合\s*并/ })).toHaveCount(0);
});
