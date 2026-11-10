/**
 * 商机 第三轮：端到端回归（客户 → 商机 → 金额合计 → 阶段推进 → 跟进 → 客户详情商机页签 → 删除约束）。
 * Deals round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { nav, signIn } from './helpers';

const SAVE = /保\s*存/;

test('商机完整业务流程 / full deals flow', async ({ page }) => {
  await signIn(page);

  // 准备客户 / prepare an account
  await nav(page, '客户');
  await page.getByRole('button', { name: '新增客户' }).click();
  let dialog = page.getByRole('dialog', { name: '新增客户' });
  await dialog.getByLabel('客户名称').fill('E2E 海川电子');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 海川电子/ })).toBeVisible();

  // 新增商机 / create deal
  await nav(page, '商机');
  await expect(page.getByText('商机管理')).toBeVisible();
  await page.getByRole('button', { name: '新增商机' }).click();
  dialog = page.getByRole('dialog', { name: '新增商机' });
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog.getByText('请填写关联客户')).toBeVisible();
  await dialog.getByLabel('商机名称').fill('E2E 服务器扩容');
  await dialog.getByLabel('关联客户').click();
  await dialog.getByLabel('关联客户').fill('海川');
  await page.getByTitle('E2E 海川电子').click();
  await dialog.getByLabel('商机金额').fill('128000.50');
  await dialog.getByLabel('销售阶段').click();
  await page.getByTitle('方案报价').click();
  await dialog.getByLabel('预计成交日期').fill('2027-06-30');
  await dialog.getByLabel('预计成交日期').press('Enter');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByText('保存成功').first()).toBeVisible();
  const row = page.getByRole('row', { name: /E2E 服务器扩容/ });
  await expect(row).toContainText('E2E 海川电子');
  await expect(row).toContainText('¥128,000.50');
  await expect(row).toContainText('方案报价');
  await expect(row).toContainText('2027-06-30');
  // 合计随筛选变化；按名称筛选后只统计本商机（其他用例可能留有商机）
  // totals follow the filter; filter by name so data from other specs does not interfere
  await page.getByPlaceholder('搜索商机名称、客户名称').fill('E2E 服务器扩容');
  await page.getByPlaceholder('搜索商机名称、客户名称').press('Enter');
  await expect(page.getByTestId('deal-sums')).toHaveText(/金额合计 \(CNY\)\s*¥128,000\.50/);
  await page.getByPlaceholder('搜索商机名称、客户名称').fill('');
  await page.getByPlaceholder('搜索商机名称、客户名称').press('Enter');

  // 详情 → 推进阶段 → 跟进 / detail → advance stage → follow-up
  await page.getByRole('button', { name: 'E2E 服务器扩容' }).click();
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  await expect(drawer).toContainText('E2E 海川电子');
  await drawer.getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑商机' });
  await dialog.getByLabel('销售阶段').click();
  await page.getByTitle('赢单').click();
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(drawer).toContainText('赢单');
  await drawer.getByRole('tab', { name: '跟进记录' }).click();
  await drawer.getByRole('button', { name: '新增跟进' }).click();
  dialog = page.getByRole('dialog', { name: '新增跟进' });
  await dialog.getByLabel('主题').fill('E2E 签约会议');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(drawer.getByTestId('related-activities')).toContainText('E2E 签约会议');
  await drawer.getByRole('button', { name: '关闭' }).first().click();

  // 搜索：按客户名找到商机 / search by account name
  await page.getByPlaceholder('搜索商机名称、客户名称').fill('海川');
  await page.getByPlaceholder('搜索商机名称、客户名称').press('Enter');
  await expect(page.getByRole('row', { name: /E2E 服务器扩容/ })).toContainText('赢单');

  // 客户详情显示商机；有商机时不能删客户 / account shows deal and cannot be deleted
  await nav(page, '客户');
  const accRow = page.getByRole('row', { name: /E2E 海川电子/ });
  await accRow.getByRole('button', { name: 'E2E 海川电子' }).click();
  const accDrawer = page.getByRole('dialog', { name: /客户详情/ });
  await accDrawer.getByRole('tab', { name: '商机 (1)' }).click();
  await expect(accDrawer.getByTestId('account-deals')).toContainText('E2E 服务器扩容');
  await accDrawer.getByRole('button', { name: '关闭' }).first().click();
  await accRow.getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByText('该客户下存在商机，请先删除或转移商机')).toBeVisible();
  await expect(accRow).toBeVisible();

  // 删除商机后可删除客户 / after deleting the deal the account can be deleted
  await nav(page, '商机');
  await page.getByRole('row', { name: /E2E 服务器扩容/ }).getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByRole('row', { name: /E2E 服务器扩容/ })).toHaveCount(0);
  await nav(page, '客户');
  await page.getByRole('row', { name: /E2E 海川电子/ }).getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByRole('row', { name: /E2E 海川电子/ })).toHaveCount(0);
});
