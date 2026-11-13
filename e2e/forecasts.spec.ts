/**
 * 销售目标与预测 第三轮：端到端回归（在表格中设定目标 → 指标与接口一致 → 季度视图只读 → 清除目标 → 审计；销售代表只看自己）。
 * Sales targets and forecast round 3: end-to-end regression.
 */
import { expect, test, type Page, type Response } from '@playwright/test';
import { fmtMoney } from '../src/lib/format';
import { nav, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

const isForecast = (r: Response) => r.url().includes('/api/forecasts?') && r.status() === 200;
const today = () => new Date().toISOString().slice(0, 10);

test('设定目标、指标一致、季度只读、清除 / set targets, matching figures, read-only quarter, clear', async ({ page }) => {
  await signIn(page);
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 预测客户' });
  await apiPost(page, '/api/deals', { name: 'E2E 预测赢单', accountId: acc.id, amount: '3000', stage: 'CLOSED_WON', expectedCloseDate: today() });
  await apiPost(page, '/api/deals', { name: 'E2E 预测谈判', accountId: acc.id, amount: '1000', stage: 'NEGOTIATION', expectedCloseDate: today() });

  let res = page.waitForResponse(isForecast);
  await nav(page, '销售预测');
  await res;
  const table = page.getByTestId('forecast-table');
  const input = table.getByLabel('系统管理员 的目标');

  // 设定目标 / set a target
  res = page.waitForResponse(isForecast);
  await input.fill('10000');
  await input.press('Enter');
  await expect(page.getByText('目标已保存').first()).toBeVisible();
  const data = await (await res).json();
  const row = data.rows.find((r: { name: string }) => r.name === '系统管理员');
  expect(row.target).toBe('10000.00');
  expect(Number(row.won)).toBeGreaterThanOrEqual(3000);
  expect(Number(row.weighted)).toBeGreaterThanOrEqual(700);
  const ui = table.getByRole('row', { name: /系统管理员/ });
  await expect(ui).toContainText(fmtMoney(row.won, 'CNY'));
  await expect(ui).toContainText(`${row.attainment}%`);
  await expect(ui).toContainText(fmtMoney(row.weighted, 'CNY'));
  await expect(ui).toContainText(fmtMoney(row.forecast, 'CNY'));
  await expect(ui).toContainText(fmtMoney(row.bestCase, 'CNY'));
  await expect(page.getByTestId('kpi-target')).toContainText(fmtMoney(data.totals.target, 'CNY'));
  await expect(page.getByTestId('forecast-total')).toContainText(fmtMoney(data.totals.forecast, 'CNY'));

  // 季度视图：目标只读 / quarter view is read-only
  res = page.waitForResponse(isForecast);
  await page.getByText('季度', { exact: true }).click();
  await res;
  await expect(page.getByText('季度目标为三个月目标之和，请切换到月视图修改。')).toBeVisible();
  await expect(table.getByLabel('系统管理员 的目标')).toHaveCount(0);
  await expect(table.getByRole('row', { name: /系统管理员/ })).toContainText('¥10,000.00');

  // 清除目标 / clear the target
  await page.getByText('月', { exact: true }).click();
  await expect(input).toHaveValue('10000.00');
  await input.fill('');
  await input.press('Enter');
  await expect(page.getByText('目标已清除').first()).toBeVisible();
  await expect(page.getByTestId('kpi-target')).toContainText('未设定');

  // 审计 / audit
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table:visible').first()).toContainText('销售目标');
});

test('销售代表只看到自己，不能设定目标 / sales reps see only themselves', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 王芳' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('销售代表');
  await page.getByRole('menu').getByRole('link', { name: '销售预测', exact: true }).click();
  await page.locator('.ant-select', { has: page.getByLabel('币种', { exact: true }) }).click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('USD', { exact: true }).click();
  const rows = page.getByTestId('forecast-table').locator('tbody tr.ant-table-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('王芳');
  await expect(page.getByTestId('forecast-table').getByRole('spinbutton')).toHaveCount(0);
  await expect(page.getByText('销售代表只看到自己的目标与预测。')).toBeVisible();
});
