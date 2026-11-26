/**
 * 自定义报表 第三轮：端到端回归（销售代表：看到共享与自己的演示报表，运行共享报表显示图表与汇总表；经理：新建商机阶段
 * 汇总报表，金额指标缺少币种时提示，加“币种等于美元”后预览，选择柱状图并共享保存，查看页显示图表与导出按钮，修改后删除；
 * 只读用户：只能运行，不能修改他人报表）。用例结束时删除新建的报表。
 * Custom reports round 3: end-to-end regression on the demo data; the created report is deleted at the end.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DEMO_REPORTS } from '../prisma/demo-data';
import { nav } from './helpers';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 按标签选择下拉选项，按结果确认 / pick a select option by label, confirmed by outcome */
async function pick(page: Page, scope: Locator, label: string, option: string) {
  const select = scope.getByLabel(label, { exact: true });
  const box = select.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await expect(async () => {
    if (!(await box.textContent())?.includes(option)) {
      await select.click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click({ timeout: 2000 });
    }
    await expect(box).toContainText(option, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

test('销售代表：运行共享的演示报表 / sales rep runs a shared demo report', async ({ page }) => {
  await demoSignIn(page, '王芳');
  await nav(page, '自定义报表');
  for (const r of DEMO_REPORTS) await expect(page.getByRole('row', { name: new RegExp(r.name.replace(/[()（）]/g, '.')) })).toBeVisible();
  await page.getByRole('link', { name: DEMO_REPORTS[1]!.name }).click();
  await expect(page).toHaveURL(/\/custom-reports\/?\?id=/);
  const result = page.getByTestId('report-result');
  await expect(page.getByTestId('report-chart')).toBeVisible();
  await expect(result).toContainText('合计');
  await expect(result).toContainText('官网');
  // 共享报表由经理创建，王芳没有编辑入口 / the manager's shared report has no edit link for 王芳
  await expect(page.getByRole('main').getByRole('link', { name: '编辑' })).toHaveCount(0);
});

test('经理：新建、预览、共享保存、修改与删除报表 / manager builds, previews, shares, edits and deletes a report', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '自定义报表');
  await page.getByTestId('report-new').click();
  const main = page.getByRole('main');
  await main.getByLabel('报表名称').fill('E2E 美元阶段报表');
  await pick(page, main, '分组', '销售阶段');
  await page.getByTestId('report-add-measure').click();
  await pick(page, main, '字段 1', '商机金额');
  await page.getByTestId('report-preview').click();
  await expect(page.getByText('金额指标需要按币种分组，或添加“币种等于”的筛选条件')).toBeVisible();
  await page.getByTestId('report-add-filter').click();
  await pick(page, main, '字段 筛选条件（全部满足） 1', '币种');
  await pick(page, main, '条件 1', '等于');
  await pick(page, main, '值 1', 'USD');
  await pick(page, main, '图表', '柱状图');
  await main.getByLabel('共享给全组织').check();
  await page.getByTestId('report-preview').click();
  const result = page.getByTestId('report-result');
  await expect(result).toContainText('合计 · 商机金额');
  await expect(result).toContainText('USD ');
  await page.getByTestId('report-save').click();
  await expect(page).toHaveURL(/\/custom-reports\/?\?id=/);
  await expect(page.getByTestId('report-chart')).toBeVisible();
  await expect(page.getByTestId('export-excel')).toBeVisible();
  // 修改：改为条形图 / edit: switch to a bar chart
  await page.getByRole('main').getByRole('link', { name: '编辑' }).click();
  await expect(main.getByLabel('报表名称')).toHaveValue('E2E 美元阶段报表');
  await pick(page, main, '图表', '条形图');
  await page.getByTestId('report-save').click();
  await expect(page).toHaveURL(/\/custom-reports\/?\?id=/);
  await expect(page.getByTestId('report-chart').getByRole('listitem').first()).toBeVisible();
  // 删除（结束时清理）/ delete (cleanup)
  await page.getByRole('main').getByRole('link', { name: '返回列表' }).click();
  const row = page.getByRole('row', { name: /E2E 美元阶段报表/ });
  await expect(row).toContainText('共享给全组织');
  await row.getByRole('button', { name: /删\s*除/ }).click();
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(row).toHaveCount(0);
});

test('只读用户：只能运行共享报表 / read-only users only run shared reports', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '自定义报表');
  const shared = DEMO_REPORTS.filter((r) => r.shared);
  await expect(page.locator('tr.ant-table-row')).toHaveCount(shared.length);
  await expect(page.getByRole('main').getByRole('link', { name: '编辑' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: /删\s*除/ })).toHaveCount(0);
  await page.getByRole('link', { name: shared[0]!.name }).click();
  await expect(page.getByTestId('report-result')).toContainText('合计');
});
