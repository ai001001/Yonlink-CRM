/**
 * 商机阶段历史 第三轮：端到端回归（经理：新建商机 → 改阶段与金额 → 详情“阶段历史”页签显示三行、当前标记、修改人郑经理、
 * 可能性与预期收入；报表页“阶段停留时长”卡片显示四个进行中阶段与成交周期；只读用户可查看演示商机的阶段历史）。基于演示数据。
 * Deal stage history round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav } from './helpers';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('经理：阶段历史页签与阶段停留时长报表 / manager: stage history and duration report', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  const accounts = await api(page, 'GET', `/api/accounts?q=${encodeURIComponent('华东涡轮')}`);
  const deal = await api(page, 'POST', '/api/deals', { name: 'E2E 阶段历史商机', accountId: accounts.items[0].id, amount: '10000' });
  await api(page, 'PATCH', `/api/deals/${deal.id}`, { stage: 'PROPOSAL' });
  await api(page, 'PATCH', `/api/deals/${deal.id}`, { amount: '20000' });

  await page.goto(`/deals?id=${deal.id}`);
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  await drawer.getByRole('tab', { name: '阶段历史' }).click();
  const panel = drawer.getByTestId('stage-history');
  const rows = panel.locator('tr.ant-table-row');
  await expect(rows).toHaveCount(3);
  // 最新在前：方案报价 ¥20,000（当前）、方案报价 ¥10,000、资格确认 / newest first
  await expect(rows.nth(0)).toContainText('方案报价');
  await expect(rows.nth(0)).toContainText('当前');
  await expect(rows.nth(0)).toContainText('20,000');
  await expect(rows.nth(0)).toContainText('40%');
  await expect(rows.nth(0)).toContainText('8,000');
  await expect(rows.nth(0)).toContainText('郑经理');
  await expect(rows.nth(1)).toContainText('10,000');
  await expect(rows.nth(2)).toContainText('资格确认');
  await expect(rows.nth(2)).toContainText('10%');

  // 报表页：阶段停留时长 / reports: stage duration card
  await page.goto('/reports');
  const card = page.getByTestId('stage-duration');
  await expect(card).toContainText('阶段停留时长');
  const stageRows = card.getByTestId('table-stage-duration').locator('tr.ant-table-row');
  await expect(stageRows).toHaveCount(4);
  await expect(stageRows.nth(0)).toContainText('资格确认');
  await expect(stageRows.nth(3)).toContainText('商务谈判');
  await expect(card).toContainText(/平均成交周期（赢单 \d+ 个）/);
  await expect(card).toContainText(/\d+(\.\d)? 天/);
});

test('只读用户：可查看演示商机的阶段历史 / read-only users can view stage history', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '商机');
  // 取一个演示的赢单商机（经历了完整的阶段推进）/ a won demo deal (it went through every stage)
  const won = await api(page, 'GET', `/api/deals?stage=CLOSED_WON&q=${encodeURIComponent('【演示】')}`);
  await page.goto(`/deals?id=${won.items[0].id}`);
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  await drawer.getByRole('tab', { name: '阶段历史' }).click();
  const rows = drawer.getByTestId('stage-history').locator('tr.ant-table-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('赢单');
  await expect(rows.last()).toContainText('资格确认');
});
