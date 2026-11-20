/**
 * 字段验证规则 第三轮：端到端回归（经理：验证规则页看到 2 条演示规则 → 新建“阶段为方案报价时必须填写预计成交日” →
 * 编辑一个没有预计成交日的商机改为方案报价，保存被拒并在“预计成交日”下显示提示 → 停用规则后可以保存；只读用户只能查看）。
 * Validation rules round 3: end-to-end regression on the demo data.
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

/** 用当前登录令牌调用 API / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
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

test('经理：新建验证规则并在商机表单中生效 / manager: a rule blocks the deal form', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '验证规则');
  await expect(page.locator('tr.ant-table-row')).toHaveCount(2);
  await expect(page.getByRole('row', { name: /大额商机须填预计成交日/ })).toContainText('金额 ≥ 1000000');

  await page.getByTestId('validation-new').click();
  const dialog = page.getByRole('dialog', { name: '新建验证规则' });
  await dialog.getByLabel('规则名称').fill('E2E 方案报价须填成交日');
  await dialog.getByTestId('validation-when-add').click();
  await pick(page, dialog, '值 适用条件 1', '方案报价');
  await dialog.getByLabel('不满足时的提示').fill('E2E 方案报价阶段请填写预计成交日');
  await pick(page, dialog, '提示显示在', '预计成交日');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 方案报价须填成交日/ });
  await expect(row).toContainText('阶段 等于 方案报价');
  await expect(row).toContainText('预计成交日 不为空');

  // 商机表单：改为方案报价且没有预计成交日 → 被拒并在字段下提示 / the deal form is refused with the message under the field
  const accounts = await api(page, 'GET', `/api/accounts?q=${encodeURIComponent('华东涡轮')}`);
  const deal = await api(page, 'POST', '/api/deals', { name: 'E2E 验证商机', accountId: accounts.items[0].id, amount: '1000' });
  await page.goto(`/deals?id=${deal.id}`);
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  await drawer.getByRole('button', { name: /编\s*辑/ }).first().click();
  const form = page.getByRole('dialog', { name: '编辑商机' });
  await pick(page, form, '销售阶段', '方案报价');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form.locator('.ant-form-item-explain-error').filter({ hasText: 'E2E 方案报价阶段请填写预计成交日' })).toBeVisible();
  await expect(form).toBeVisible();
  // 停用规则后可以保存 / after disabling the rule the save succeeds
  await page.goto('/validation-rules');
  await page.getByRole('row', { name: /E2E 方案报价须填成交日/ }).getByRole('switch').click();
  await expect.poll(async () => (await api(page, 'GET', '/api/validation-rules?entity=DEAL')).items.find((r: { name: string }) => r.name === 'E2E 方案报价须填成交日').isActive).toBe(false);
  const res = await page.request.patch(`/api/deals/${deal.id}`, { headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('yonlink-crm.token'))}` }, data: { stage: 'PROPOSAL' } });
  expect(res.status()).toBe(200);
});

test('只读用户：验证规则只能查看 / read-only users can only view', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await page.goto('/validation-rules');
  await expect(page.locator('tr.ant-table-row').first()).toBeVisible();
  await expect(page.getByTestId('validation-new')).toHaveCount(0);
  await expect(page.locator('tr.ant-table-row').first().getByRole('switch')).toBeDisabled();
});
