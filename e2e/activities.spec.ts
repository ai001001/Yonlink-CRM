/**
 * 跟进 第三轮：端到端回归（关联线索/客户/商机 → 任务截止 → 完成状态 → 编辑 → 删除 → 线索详情时间线）。
 * Activities round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { nav, signIn } from './helpers';

const SAVE = /保\s*存/;

test('跟进管理完整业务流程 / full activities flow', async ({ page }) => {
  await signIn(page);

  // 准备线索 / prepare a lead
  await nav(page, '线索');
  await page.getByRole('button', { name: '新增线索' }).click();
  let dialog = page.getByRole('dialog', { name: '新增线索' });
  await dialog.getByLabel('姓名').fill('E2E 跟进线索');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 跟进线索/ })).toBeVisible();

  // 新增任务并关联线索 / create a task linked to the lead
  await nav(page, '跟进');
  await expect(page.getByText('跟进管理')).toBeVisible();
  await page.getByRole('button', { name: '新增跟进' }).click();
  dialog = page.getByRole('dialog', { name: '新增跟进' });
  await dialog.getByLabel('类型').click();
  await page.getByTitle('任务').click();
  await dialog.getByLabel('主题').fill('E2E 发送报价单');
  await dialog.getByLabel('截止/计划时间').fill('2020-01-02 09:00');
  await dialog.getByLabel('截止/计划时间').press('Enter');
  await dialog.getByLabel('关联线索').click();
  await dialog.getByLabel('关联线索').fill('跟进线索');
  await page.getByTitle('E2E 跟进线索').click();
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByText('保存成功').first()).toBeVisible();
  const row = page.getByRole('row', { name: /E2E 发送报价单/ });
  await expect(row).toContainText('任务');
  await expect(row).toContainText('线索: E2E 跟进线索');
  await expect(row).toContainText('2020-01-02 09:00');
  await expect(row).toContainText('已逾期');

  // 再加一条电话记录（已完成）/ a completed call record
  await page.getByRole('button', { name: '新增跟进' }).click();
  await dialog.getByLabel('主题').fill('E2E 电话回访');
  await dialog.getByLabel('已完成').click();
  await dialog.getByRole('button', { name: SAVE }).click();
  // 默认只显示未完成 / default view shows pending only
  await expect(page.getByRole('row', { name: /E2E 电话回访/ })).toHaveCount(0);
  await page.getByText('已完成', { exact: true }).first().click();
  await expect(page.getByRole('row', { name: /E2E 电话回访/ })).toBeVisible();

  // 标记任务完成 / complete the task
  await page.getByText('未完成', { exact: true }).first().click();
  // 受控复选框：服务端确认后列表刷新 / controlled checkbox: list refreshes after the server confirms
  await page.getByRole('checkbox', { name: '标记完成 E2E 发送报价单' }).click();
  await expect(page.getByRole('row', { name: /E2E 发送报价单/ })).toHaveCount(0);
  await page.getByText('全部', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '标记完成 E2E 发送报价单' })).toBeChecked();

  // 详情与编辑 / detail and edit
  await page.getByRole('button', { name: 'E2E 发送报价单' }).click();
  const drawer = page.getByRole('dialog', { name: 'E2E 发送报价单' });
  await expect(drawer).toContainText('已完成 ·');
  await drawer.getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑跟进' });
  await dialog.getByLabel('内容').fill('报价单已通过邮件发送');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(drawer).toContainText('报价单已通过邮件发送');
  await drawer.getByRole('button', { name: '关闭' }).first().click();

  // 线索详情中可见该跟进 / visible in the lead timeline
  await nav(page, '线索');
  await page.getByRole('button', { name: 'E2E 跟进线索' }).click();
  const leadDrawer = page.getByRole('dialog', { name: '线索详情' });
  await expect(leadDrawer.getByTestId('related-activities')).toContainText('E2E 发送报价单');
  await leadDrawer.getByRole('button', { name: '关闭' }).first().click();

  // 删除跟进 / delete activity
  await nav(page, '跟进');
  await page.getByText('全部', { exact: true }).click();
  await page.getByRole('row', { name: /E2E 电话回访/ }).getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByRole('row', { name: /E2E 电话回访/ })).toHaveCount(0);
  await page.reload();
  await page.getByText('全部', { exact: true }).click();
  await expect(page.getByRole('row', { name: /E2E 发送报价单/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 电话回访/ })).toHaveCount(0);
});
