/**
 * 销售报表 第三轮：端到端回归（页面数字与接口数据一致 → 切换币种 → 负责人筛选 → 销售代表只看自己）。
 * Sales reports round 3: end-to-end regression.
 */
import { expect, test, type Page, type Response } from '@playwright/test';
import { fmtMoney } from '../src/lib/format';
import { nav } from './helpers';

/** 演示账号一键登录 / one-click demo login */
async function demoLogin(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

const isReport = (r: Response) => r.url().includes('/api/reports/sales') && r.status() === 200;
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

test('报表数字与接口一致，可切换币种与负责人 / figures match the API; currency and owner filters', async ({ page }) => {
  await demoLogin(page, '周会计');
  const first = page.waitForResponse(isReport);
  await nav(page, '报表');
  let data = await (await first).json();
  const reports = page.getByTestId('reports');
  await expect(page.getByTestId('kpi-open')).toContainText(fmtMoney(data.summary.openAmount, 'CNY'));
  await expect(page.getByTestId('kpi-won')).toContainText(fmtMoney(data.summary.wonAmount, 'CNY'));
  await expect(page.getByTestId('kpi-win-rate')).toContainText(pct(data.summary.winRate));
  await expect(page.getByTestId('kpi-lead-conversion')).toContainText(pct(data.summary.leadConversionRate));
  await expect(page.getByTestId('kpi-quote-acceptance')).toContainText(pct(data.summary.quoteAcceptanceRate));
  await expect(page.getByTestId('chart-funnel').getByRole('listitem')).toHaveCount(4);
  await expect(page.getByTestId('chart-monthly').locator('g[data-key]')).toHaveCount(data.monthly.length);
  await expect(page.getByTestId('table-owners').locator('tbody tr.ant-table-row')).toHaveCount(data.owners.length);
  await expect(reports).toContainText('销售漏斗（进行中商机）');

  // 切换币种 / switch currency
  let next = page.waitForResponse((r) => isReport(r) && r.url().includes('currency=USD'));
  await page.getByLabel('币种').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('USD', { exact: true }).click();
  data = await (await next).json();
  expect(data.currency).toBe('USD');
  await expect(page.getByTestId('kpi-open')).toContainText(fmtMoney(data.summary.openAmount, 'USD'));
  await expect(page.getByTestId('kpi-won')).toContainText(fmtMoney(data.summary.wonAmount, 'USD'));

  // 负责人筛选：排行只剩该负责人 / owner filter
  next = page.waitForResponse((r) => isReport(r) && r.url().includes('ownerId='));
  await page.getByLabel('负责人').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('陈静', { exact: true }).click();
  data = await (await next).json();
  await expect(page.getByTestId('kpi-open')).toContainText(fmtMoney(data.summary.openAmount, 'USD'));
  const rows = page.getByTestId('table-owners').locator('tbody tr.ant-table-row');
  await expect(rows).toHaveCount(data.owners.length);
  if (data.owners.length) await expect(rows.first()).toContainText('陈静');
});

test('销售代表只统计自己负责的数据，没有负责人筛选 / sales reps see only their own data', async ({ page }) => {
  await demoLogin(page, '王芳');
  const res = page.waitForResponse(isReport);
  await nav(page, '报表');
  const data = await (await res).json();
  await expect(page.getByText('销售代表只统计自己负责的数据。')).toBeVisible();
  await expect(page.getByLabel('负责人')).toHaveCount(0);
  for (const o of data.owners) expect(o.name).toBe('王芳');
  await expect(page.getByTestId('kpi-open')).toContainText(fmtMoney(data.summary.openAmount, 'CNY'));
});
