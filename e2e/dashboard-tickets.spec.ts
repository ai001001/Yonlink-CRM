/**
 * 工作台“我的待处理工单”卡片 第三轮：端到端回归（演示销售王芳登录 → 卡片显示数量与逾期数、按优先级排序、逾期标记 →
 * 点击打开工单详情 → “查看全部”进入服务工单页）。
 * Dashboard "my pending tickets" card round 3: end-to-end regression with the demo sales rep.
 */
import { expect, test } from '@playwright/test';

test('我的待处理工单卡片 / my pending tickets card', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 王芳' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('王芳');
  const card = page.getByTestId('my-tickets');
  await expect(card).toContainText('未解决 3 项，已逾期 1 项');
  const items = card.locator('.ant-list-item');
  await expect(items).toHaveCount(3);
  // 高优先级在前；同为中优先级时期限早的（已逾期）在前 / high first; among medium, the earlier (overdue) one first
  await expect(items.nth(0)).toContainText('涡轮增压器异响');
  await expect(items.nth(0)).toContainText('高');
  await expect(items.nth(1)).toContainText('增压压力偏低');
  await expect(items.nth(1)).toContainText('已逾期');
  await expect(items.nth(2)).toContainText('双语安装手册');

  await items.nth(0).getByRole('link').click();
  await expect(page.getByRole('dialog', { name: /工单详情 · CS-/ })).toContainText('涡轮增压器异响');
  await page.goto('/');
  await card.getByRole('link', { name: '查看全部' }).click();
  await expect(page).toHaveURL(/\/tickets\/?$/);
  await expect(page.getByRole('row', { name: /增压压力偏低/ })).toBeVisible();
});
