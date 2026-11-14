/**
 * 线索转化 第三轮：端到端回归（线索 + 跟进 → 转化为新客户 + 商机 → 结果链接 → 客户/商机中可见 → 不可重复转化）。
 * Lead conversion round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { closeDrawer, nav, signIn } from './helpers';

const SAVE = /保\s*存/;

test('线索转化完整流程 / full lead conversion flow', async ({ page }) => {
  await signIn(page);

  // 准备线索与跟进 / lead with a follow-up
  await nav(page, '线索');
  await page.getByRole('button', { name: '新增线索' }).click();
  let dialog = page.getByRole('dialog', { name: '新增线索' });
  await dialog.getByLabel('姓名').fill('E2E 转化张三');
  await dialog.getByLabel('公司').fill('E2E 星河转化科技');
  await dialog.getByLabel('职位').fill('采购经理');
  await dialog.getByLabel('邮箱').fill('convert@example.com');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 转化张三/ })).toBeVisible();

  await page.getByRole('button', { name: 'E2E 转化张三' }).click();
  const drawer = page.getByRole('dialog', { name: '线索详情' });
  await drawer.getByRole('button', { name: '新增跟进' }).click();
  dialog = page.getByRole('dialog', { name: '新增跟进' });
  await dialog.getByLabel('主题').fill('E2E 转化前电话');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(drawer.getByTestId('related-activities')).toContainText('E2E 转化前电话');

  // 转化 / convert
  await drawer.getByRole('button', { name: /^(swap )?转\s*化$/ }).click();
  dialog = page.getByRole('dialog', { name: '转化线索' });
  await expect(dialog.getByLabel('客户名称')).toHaveValue('E2E 星河转化科技');
  await expect(dialog).toContainText('将以“E2E 转化张三”创建联系人');
  await dialog.getByLabel('同时创建商机').check();
  await dialog.getByLabel('商机名称').fill('E2E 转化商机');
  await dialog.getByLabel('商机金额').fill('50000');
  await dialog.getByRole('button', { name: '确认转化' }).click();
  await expect(page.getByText('线索已转化').first()).toBeVisible();

  // 详情显示转化结果，转化按钮消失 / result shown, convert button gone
  const result = drawer.getByTestId('conversion-result');
  await expect(result).toContainText('E2E 星河转化科技');
  await expect(result).toContainText('E2E 转化张三');
  await expect(result).toContainText('E2E 转化商机');
  await expect(drawer).toContainText('已转化');
  await expect(drawer.getByRole('button', { name: /^(swap )?转\s*化$/ })).toHaveCount(0);

  // 列表中转化按钮禁用；编辑时状态锁定 / list button disabled; status locked when editing
  await closeDrawer(page, drawer);
  const row = page.getByRole('row', { name: /E2E 转化张三/ });
  await expect(row).toContainText('已转化');
  await expect(row.getByRole('button', { name: /^(swap )?转\s*化$/ })).toBeDisabled();
  await row.getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑线索' });
  await expect(dialog).toContainText('已转化线索的状态不可修改');
  await dialog.getByLabel('备注').fill('已转化后补充备注');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByText('保存成功').first()).toBeVisible();

  // 跳到客户：联系人与跟进均已关联 / account has the contact and the follow-up
  await row.getByRole('button', { name: 'E2E 转化张三' }).click();
  await drawer.getByTestId('conversion-result').getByRole('link', { name: 'E2E 星河转化科技' }).click();
  const accDrawer = page.getByRole('dialog', { name: /客户详情 · E2E 星河转化科技/ });
  await expect(accDrawer).toBeVisible();
  await accDrawer.getByRole('tab', { name: '联系人 (1)' }).click();
  await expect(accDrawer.getByTestId('contacts-panel')).toContainText('采购经理');
  await expect(accDrawer.getByTestId('contacts-panel')).toContainText('主要联系人');
  await accDrawer.getByRole('tab', { name: '商机 (1)' }).click();
  await expect(accDrawer.getByTestId('account-deals')).toContainText('¥50,000.00');
  await accDrawer.getByRole('tab', { name: '跟进记录' }).click();
  await expect(accDrawer.getByTestId('related-activities')).toContainText('E2E 转化前电话');
});
