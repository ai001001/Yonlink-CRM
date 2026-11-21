/**
 * 自定义字段 第三轮：端到端回归（管理员：设置 › 自定义字段看到演示字段 → 新建线索下拉字段 → 新增线索表单出现该字段，
 * 选择后保存 → 线索详情的“自定义字段”显示值；客户详情显示演示字段值）。新建字段不设必填，避免影响共用测试库的其他用例。
 * Custom fields round 3: end-to-end regression on the demo data.
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

test('管理员：新建自定义字段并在线索表单与详情中使用 / admin: create and use a custom field', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '林管理');
  await nav(page, '自定义字段');
  await expect(page.getByRole('row', { name: /【演示】意向产品线/ })).toContainText('下拉选项');

  await page.getByTestId('custom-field-new').click();
  const dialog = page.getByRole('dialog', { name: '新建字段' });
  await dialog.getByLabel('字段名称').fill('E2E 预算范围');
  await pick(page, dialog, '类型', '下拉选项');
  const options = dialog.getByLabel('选项', { exact: true });
  for (const o of ['10 万以下', '10–50 万']) {
    await options.fill(o);
    await options.press('Enter');
  }
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /E2E 预算范围/ })).toContainText('10–50 万');

  // 新增线索：表单中出现字段 / the lead form shows the field
  await page.goto('/leads');
  await page.getByRole('button', { name: '新增线索' }).click();
  const form = page.getByRole('dialog', { name: '新增线索' });
  await form.getByLabel('姓名').fill('E2E 自定义字段线索');
  await pick(page, form, 'E2E 预算范围', '10–50 万');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form).toBeHidden();
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const list = await (await page.request.get(`/api/leads?q=${encodeURIComponent('E2E 自定义字段线索')}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  await page.goto(`/leads?id=${list.items[0].id}`);
  const values = page.getByTestId('custom-field-values');
  await expect(values).toContainText('E2E 预算范围');
  await expect(values).toContainText('10–50 万');

  // 客户详情：演示字段值 / account detail shows demo values
  const accounts = await (await page.request.get('/api/accounts?pageSize=1', { headers: { Authorization: `Bearer ${token}` } })).json();
  await page.goto(`/accounts?id=${accounts.items[0].id}`);
  await expect(page.getByTestId('custom-field-values')).toContainText('【演示】年采购预算（万元）');
});
