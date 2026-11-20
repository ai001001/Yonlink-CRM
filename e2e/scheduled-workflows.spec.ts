/**
 * 定时工作流 第三轮：端到端回归（经理：工作流规则页显示演示定时规则的描述 → 新建“商机预计成交日前 2 天”规则 →
 * 列表与接口中的触发设置正确 → 编辑时回显“之前 2 天”）。定时执行由定时任务完成，执行逻辑在 R1/R2 覆盖。
 * Scheduled workflows round 3: end-to-end regression on the demo data (execution is covered by R1/R2).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { nav } from './helpers';

const SAVE = /保\s*存/;

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 在弹窗内选择下拉选项并按结果确认 / pick a select option in a dialog, confirmed by outcome */
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

test('经理：新建相对日期定时规则 / manager: create a relative-date rule', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '工作流规则');
  await expect(page.getByRole('row', { name: /高分线索 7 天无跟进提醒/ })).toContainText('连续 7 天无跟进');
  await expect(page.getByRole('row', { name: /预计成交日前 3 天提醒负责人/ })).toContainText('预计成交日前 3 天');

  await page.getByRole('button', { name: '新建工作流规则' }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作流规则' });
  await dialog.getByLabel('规则名称').fill('E2E 成交日前 2 天');
  await pick(page, dialog, '对象', '商机');
  await pick(page, dialog, '触发时机', '相对日期（定时）');
  await expect(dialog.getByLabel('日期字段', { exact: true }).locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]')).toContainText('预计成交日');
  await dialog.getByLabel('天数', { exact: true }).fill('2');
  await dialog.getByLabel('提醒内容 1', { exact: true }).fill('E2E 两天后成交');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 成交日前 2 天/ });
  await expect(row).toContainText('预计成交日前 2 天');

  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const list = await (await page.request.get('/api/workflows?entity=DEAL', { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(list.items.find((r: { name: string }) => r.name === 'E2E 成交日前 2 天')).toMatchObject({ trigger: 'DATE_RELATIVE', triggerField: 'expectedCloseDate', triggerDays: -2 });

  // 编辑时回显 / the edit dialog shows the saved setting
  await row.getByRole('button', { name: /编\s*辑/ }).click();
  const edit = page.getByRole('dialog', { name: '编辑工作流规则' });
  await expect(edit.getByLabel('天数', { exact: true })).toHaveValue('2');
  await expect(edit.getByLabel('之前/之后', { exact: true }).locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]')).toContainText('之前');
});
