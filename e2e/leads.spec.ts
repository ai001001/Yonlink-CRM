/**
 * 线索 第三轮：端到端回归（登录 → 新增 → 搜索 → 详情 → 编辑 → 删除 → 刷新后仍正确）。
 * Leads round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { closeDrawer, nav, searchList, selectOption, signIn } from './helpers';

test('线索完整业务流程 / full leads flow', async ({ page }) => {
  await signIn(page);
  await nav(page, '线索');
  await expect(page.getByText('线索管理')).toBeVisible();

  // 新增 / create
  await page.getByRole('button', { name: '新增线索' }).click();
  let dialog = page.getByRole('dialog', { name: '新增线索' });
  await dialog.getByLabel('姓名').fill('E2E 线索甲');
  await dialog.getByLabel('公司').fill('永联测试有限公司');
  await dialog.getByLabel('手机').fill('13912345678');
  await dialog.getByLabel('邮箱').fill('e2e-lead@example.com');
  await selectOption(page, dialog, '线索来源', '展会');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('保存成功').first()).toBeVisible();
  const row = page.getByRole('row', { name: /E2E 线索甲/ });
  await expect(row).toContainText('展会');
  await expect(row).toContainText('新线索');

  // 必填校验 / required validation
  await page.getByRole('button', { name: '新增线索' }).click();
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog.getByText('请填写姓名')).toBeVisible();
  await dialog.getByRole('button', { name: /取\s*消/ }).click();

  // 第二条，用于搜索 / second lead for search
  await page.getByRole('button', { name: '新增线索' }).click();
  await dialog.getByLabel('姓名').fill('E2E 线索乙');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('row', { name: /E2E 线索乙/ })).toBeVisible();

  // 搜索 / search
  await searchList(page, '搜索姓名、公司、邮箱、电话', '永联测试');
  await expect(page.getByRole('row', { name: /E2E 线索乙/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /E2E 线索甲/ })).toBeVisible();

  // 详情 / detail
  await page.getByRole('button', { name: 'E2E 线索甲' }).click();
  const drawer = page.getByRole('dialog', { name: '线索详情' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('13912345678');
  await expect(drawer).toContainText('e2e-lead@example.com');

  // 编辑状态 / edit status
  await drawer.getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑线索' });
  await selectOption(page, dialog, '线索状态', '已确认');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(drawer).toContainText('已确认');
  await closeDrawer(page, drawer);

  // 刷新后数据仍在（来自数据库）/ data survives reload (persisted)
  await page.reload();
  await expect(page.getByRole('row', { name: /E2E 线索甲/ })).toContainText('已确认');

  // 删除 / delete
  await page.getByRole('row', { name: /E2E 线索甲/ }).getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByText('已移入回收站').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 线索甲/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('row', { name: /E2E 线索乙/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 线索甲/ })).toHaveCount(0);
});

test('未登录访问业务页跳转登录 / unauthenticated access redirects to login', async ({ page }) => {
  await page.goto('/leads');
  await expect(page).toHaveURL(/\/login/);
});
