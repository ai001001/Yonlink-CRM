/**
 * 列表导出 Excel 第三轮：端到端回归（经理在线索、商机、工单列表点“下载 Excel”，核对文件名、工作表名、表头与数字单元格；
 * 筛选后导出只含筛选结果；只读用户没有“下载 Excel”按钮）。基于演示数据。
 * List Excel export round 3: end-to-end regression on the demo data.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { readXlsx } from '../tests/report-excel/xlsx-reader';
import { nav, selectOption } from './helpers';

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
  return { name: download.suggestedFilename(), book: readXlsx(await readFile(await download.path())) };
}

test('经理下载线索、商机、工单列表 Excel / manager downloads lists as Excel', async ({ page }) => {
  test.setTimeout(90_000);
  await demoSignIn(page, '郑经理');

  // 线索：全部 → 按状态筛选后只含筛选结果 / leads: all, then filtered
  await nav(page, '线索');
  await expect(page).toHaveURL(/\/leads\/?$/);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toBeVisible();
  const all = await excel(page);
  expect(all.name).toMatch(/^leads-\d{8}\.xlsx$/);
  expect(all.book.names).toEqual(['线索']);
  expect(all.book.sheets[0]!.values[0]!.slice(0, 3)).toEqual(['姓名', '公司', '职位']);
  const total = all.book.sheets[0]!.values.length - 1;
  expect(total).toBeGreaterThan(10);
  await selectOption(page, page.locator('main'), '线索状态', '已联系');
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toBeVisible();
  const filtered = await excel(page);
  const rows = filtered.book.sheets[0]!.values.slice(1);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(total);
  expect(rows.every((r) => r.includes('已联系'))).toBe(true);

  // 商机：金额为数字单元格 / deals: amount cells are numbers
  // 等页面切换完成再导出，否则会点到上一页的按钮 / wait for the page switch, or the previous page's button is clicked
  await nav(page, '商机');
  await expect(page).toHaveURL(/\/deals\/?$/);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toBeVisible();
  const dealsBook = await excel(page);
  expect(dealsBook.name).toMatch(/^deals-\d{8}\.xlsx$/);
  expect(dealsBook.book.names).toEqual(['商机']);
  const amount = dealsBook.book.sheets[0]!.rows[1]!.cells.find((c) => c.ref.startsWith('C'))!;
  expect(amount).toMatchObject({ type: null, style: 2 });
  expect(Number(amount.value)).toBeGreaterThan(0);

  // 工单 / tickets
  await nav(page, '服务工单');
  await expect(page).toHaveURL(/\/tickets\/?$/);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toBeVisible();
  const ticketBook = await excel(page);
  expect(ticketBook.name).toMatch(/^tickets-\d{8}\.xlsx$/);
  expect(ticketBook.book.names).toEqual(['服务工单']);
  expect(ticketBook.book.sheets[0]!.values.length).toBeGreaterThan(1);
});

test('只读用户没有列表“下载 Excel”按钮 / read-only users have no list Excel download', async ({ page }) => {
  await demoSignIn(page, '周会计');
  for (const menu of ['线索', '客户', '商机'] as const) {
    await nav(page, menu);
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toBeVisible();
    await expect(page.getByTestId('export-excel')).toHaveCount(0);
  }
});
