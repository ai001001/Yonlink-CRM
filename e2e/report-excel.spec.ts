/**
 * 报表导出 Excel 第三轮：端到端回归（经理在销售报表、销售预测、应收账款页点“下载 Excel”，核对文件名、工作表与内容；
 * 只读用户没有“下载 Excel”按钮）。基于演示数据。
 * Report Excel export round 3: end-to-end regression on the demo data.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { readXlsx } from '../tests/report-excel/xlsx-reader';
import { nav } from './helpers';

/** 演示账号一键登录 / demo one-click sign-in */
async function demoSignIn(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 点击“下载 Excel”并读取工作簿 / click "Download Excel" and read the workbook */
async function excel(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('main').getByTestId('export-excel').click();
  const download = await downloadPromise;
  const buf = await readFile(await download.path());
  return { name: download.suggestedFilename(), buf, book: readXlsx(buf) };
}

test('经理下载销售报表、销售预测、应收账款 Excel / manager downloads the reports as Excel', async ({ page }) => {
  test.setTimeout(90_000);
  await demoSignIn(page, '郑经理');

  // 销售报表：7 个工作表 / sales report: 7 sheets
  await nav(page, '报表');
  await expect(page.getByTestId('reports')).toBeVisible();
  const sales = await excel(page);
  expect(sales.name).toMatch(/^sales-report-CNY-\d{8}-\d{8}\.xlsx$/);
  expect(sales.buf.subarray(0, 2).toString()).toBe('PK');
  expect(sales.book.names).toEqual(['概览', '销售漏斗（进行中商机）', '按月赢单', '负责人排行', '线索来源转化', '报价单状态', '竞争对手胜负']);
  expect(sales.book.sheets[0]!.values[0]).toEqual(['销售报表']);
  expect(sales.book.sheets[3]!.values.map((r) => r[0])).toContain('王芳');
  await expect(page.getByText(/已导出 \d+ 条/).first()).toBeVisible();

  // 销售预测：表头与合计 / forecast: header and total
  await nav(page, '销售预测');
  await expect(page.getByTestId('forecast-table')).toBeVisible();
  const forecast = await excel(page);
  expect(forecast.name).toMatch(/^forecast-CNY-\d{4}-\d{2}\.xlsx$/);
  const fs = forecast.book.sheets[0]!;
  expect(fs.values[4]![0]).toBe('负责人');
  expect(fs.values.at(-1)![0]).toBe('团队合计');
  expect(fs.values.map((r) => r[0])).toContain('陈静');

  // 应收账款：三个工作表，明细 2 张发票 / receivables: three sheets, 2 invoices
  await page.goto('/reports/receivables');
  await expect(page.getByTestId('kpi-outstanding')).toContainText('2 张发票');
  const recv = await excel(page);
  expect(recv.name).toMatch(/^receivables-CNY-\d{8}\.xlsx$/);
  expect(recv.book.names).toEqual(['概览', '按客户汇总', '未收发票']);
  expect(recv.book.sheets[2]!.values).toHaveLength(3);
  expect(recv.book.sheets[2]!.values.map((r) => r[1])).toContain('【演示】北方重卡配件集团');
  // 金额单元格为数字 / amount cells are numbers
  const balance = recv.book.sheets[2]!.rows[1]!.cells[7]!;
  expect(balance.type).toBeNull();
  expect(Number(balance.value)).toBeGreaterThan(0);
});

test('只读用户没有“下载 Excel”按钮 / read-only users have no Excel download', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '报表');
  await expect(page.getByTestId('reports')).toBeVisible();
  await expect(page.getByTestId('export-excel')).toHaveCount(0);
  await nav(page, '销售预测');
  await expect(page.getByTestId('forecast-table')).toBeVisible();
  await expect(page.getByTestId('export-excel')).toHaveCount(0);
  await page.goto('/reports/receivables');
  await expect(page.getByTestId('kpi-outstanding')).toBeVisible();
  await expect(page.getByTestId('export-excel')).toHaveCount(0);
});
