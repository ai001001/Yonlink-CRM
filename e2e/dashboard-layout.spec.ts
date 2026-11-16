/**
 * 工作台自定义 第三轮：端到端回归（默认显示全部卡片 → 隐藏“最近跟进记录”、把“即将成交”移到最前 → 保存后顺序生效、
 * 刷新后保持 → 即将成交跳转商机详情 → 恢复默认）。使用演示经理账号，避免影响其他用例使用的管理员工作台。
 * Dashboard customisation round 3: end-to-end regression with the demo manager account.
 */
import { expect, test, type Page } from '@playwright/test';

/** 当前工作台卡片顺序 / current card order */
const order = (page: Page) => page.locator('[data-testid^="widget-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));

test('自定义工作台：隐藏、排序、保存、恢复默认 / customise the dashboard', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 郑经理' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('郑经理');
  await expect(page.getByTestId('widget-stages')).toBeVisible();
  expect(await order(page)).toEqual(['widget-counts', 'widget-dealAmounts', 'widget-myTodos', 'widget-myTickets', 'widget-recentActivities', 'widget-closingSoon', 'widget-stages']);

  // 隐藏最近跟进、把即将成交移到最前 / hide recent activities, move closing soon to the top
  await page.getByRole('button', { name: '自定义工作台' }).click();
  const panel = page.getByRole('dialog', { name: '自定义工作台' });
  await panel.getByRole('checkbox', { name: '最近跟进记录' }).uncheck();
  for (let i = 0; i < 5; i++) await panel.getByRole('button', { name: '上移 即将成交的商机' }).click();
  await expect(panel.getByRole('button', { name: '上移 即将成交的商机' })).toBeDisabled();
  await panel.getByRole('button', { name: /保\s*存/ }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('widget-recentActivities')).toHaveCount(0);
  expect(await order(page)).toEqual(['widget-closingSoon', 'widget-counts', 'widget-dealAmounts', 'widget-myTodos', 'widget-myTickets', 'widget-stages']);

  // 刷新后保持 / persists after reload
  await page.reload();
  await expect(page.getByTestId('widget-closingSoon')).toBeVisible();
  expect(await order(page)).toEqual(['widget-closingSoon', 'widget-counts', 'widget-dealAmounts', 'widget-myTodos', 'widget-myTickets', 'widget-stages']);

  // 即将成交跳转商机详情 / open a deal from closing soon
  const first = page.getByTestId('closing-soon').getByRole('link').first();
  const name = await first.innerText();
  await first.click();
  await expect(page.getByRole('dialog', { name: `商机详情 · ${name}` })).toBeVisible();
  await page.goto('/');

  // 恢复默认 / reset
  await page.getByRole('button', { name: '自定义工作台' }).click();
  await panel.getByRole('button', { name: '恢复默认' }).click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('widget-recentActivities')).toBeVisible();
  expect(await order(page)).toEqual(['widget-counts', 'widget-dealAmounts', 'widget-myTodos', 'widget-myTickets', 'widget-recentActivities', 'widget-closingSoon', 'widget-stages']);
});
