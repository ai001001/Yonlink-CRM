/**
 * 线索分配规则 第三轮：端到端回归（经理：线索列表打开分配规则 → 看到 4 条演示规则 → 新增“公司包含 E2E汽配 → 陈静”并移到最前 →
 * 保存 → 两条 E2E 线索批量“按规则重新分配”后负责人为陈静 → 网页表单列表显示“按分配规则”；只读用户只能查看）。基于演示数据。
 * Assignment rules round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
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

test('经理：分配规则维护与批量按规则重新分配 / manager: assignment rules', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');
  for (const n of ['一', '二']) await api(page, 'POST', '/api/leads', { name: `E2E 分配线索${n}`, company: `E2E汽配${n}厂` });
  await nav(page, '线索');

  // 新建一个按规则分配的官网来源表单（不改动演示表单），提交两次后官网规则已分配 2 次
  // a new rule-assigned website form (the demo forms stay untouched); two submissions → the website rule made 2 assignments
  const key = (await api(page, 'POST', '/api/web-forms', { name: 'E2E 按规则表单', title: 'E2E', source: 'WEBSITE', assignByRule: true })).publicKey;
  for (const n of ['甲', '乙']) {
    const res = await page.request.post(`/api/public/web-forms/${key}`, { data: { name: `E2E 官网访客${n}`, email: 'visitor@example.com' }, headers: { 'x-forwarded-for': `10.9.0.${n === '甲' ? 1 : 2}` } });
    expect(res.ok()).toBe(true);
  }

  // 打开分配规则：4 条演示规则 / open the rules: 4 demo rules
  await page.getByTestId('assignment-open').click();
  const modal = page.getByRole('dialog', { name: '分配规则' });
  const rules = modal.getByTestId('assignment-rule');
  await expect(rules).toHaveCount(4);
  await expect(modal.getByLabel('规则名称 1', { exact: true })).toHaveValue('【演示】展会线索');
  await expect(modal.getByLabel('规则名称 4', { exact: true })).toHaveValue('【演示】其余线索兜底');
  await expect(rules.nth(1)).toContainText('已分配 2 次');
  await expect(rules.nth(0)).toContainText('已分配 0 次');

  // 新增第 5 条：公司包含 E2E汽配 → 陈静 / add rule 5: company contains E2E汽配 → 陈静
  await modal.getByTestId('assignment-add').click();
  await expect(rules).toHaveCount(5);
  await modal.getByLabel('规则名称 5', { exact: true }).fill('E2E 汽配公司');
  // 多选：点选后点击名称框收起下拉（不用 Esc，避免关闭弹窗）/ multi-select: pick, then click the name box to close the list
  await expect(async () => {
    const users = rules.nth(4).locator('.ant-select-selection-item');
    if (!(await users.filter({ hasText: '陈静' }).count())) {
      await modal.getByLabel('轮流分配给 5', { exact: true }).click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible').getByTitle('陈静', { exact: true }).click({ timeout: 2000 });
    }
    await expect(users.filter({ hasText: '陈静' })).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await modal.getByLabel('规则名称 5', { exact: true }).click();
  await rules.nth(4).getByTestId('assignment-add-condition').click();
  // 字段从“线索来源”改为“公司”，比较方式自动变为“包含” / switch the field to company; the operator becomes "contains"
  // 切换成功的标志：规则 5 内出现两个文本框（名称 + 值）/ success shows two text inputs in rule 5 (name + value)
  const textInputs = rules.nth(4).locator('input.ant-input:visible');
  await expect(async () => {
    if ((await textInputs.count()) < 2) {
      await modal.getByLabel('字段 5.1', { exact: true }).click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible').getByTitle('公司', { exact: true }).click({ timeout: 2000 });
    }
    await expect(textInputs).toHaveCount(2, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await expect(rules.nth(4)).toContainText('包含');
  await modal.getByLabel('值 5.1', { exact: true }).fill('E2E汽配');
  // 移到最前（上移 4 次）/ move it to the top
  for (const i of [5, 4, 3, 2]) await modal.getByRole('button', { name: `上移 ${i}`, exact: true }).click();
  await expect(modal.getByLabel('规则名称 1', { exact: true })).toHaveValue('E2E 汽配公司');
  await modal.getByRole('button', { name: SAVE }).click();
  await expect(page.getByText('分配规则已保存')).toBeVisible();
  await expect(modal).toBeHidden();
  const saved = await api(page, 'GET', '/api/assignment-rules');
  expect(saved.rules.map((r: { name: string }) => r.name)).toEqual(['E2E 汽配公司', '【演示】展会线索', '【演示】官网询盘轮流分配', '【演示】采购岗位', '【演示】其余线索兜底']);
  expect(saved.rules[0].conditions).toEqual([{ field: 'company', op: 'CONTAINS', value: 'E2E汽配' }]);

  // 批量按规则重新分配 / bulk reassign by rules
  await page.getByPlaceholder('搜索姓名、公司、邮箱、电话').fill('E2E 分配线索');
  await page.getByPlaceholder('搜索姓名、公司、邮箱、电话').press('Enter');
  await expect(page.locator('tr.ant-table-row')).toHaveCount(2);
  for (const row of await page.locator('tr.ant-table-row').all()) await expect(row).toContainText('郑经理');
  await page.locator('thead .ant-checkbox-input').check();
  await page.getByTestId('bulk-bar').getByTestId('bulk-assign-rule').click();
  await expect(page.locator('.ant-modal-confirm-title')).toContainText('按分配规则重新分配选中的 2 条线索');
  await page.getByRole('button', { name: SAVE }).click();
  await expect(page.getByText('已处理 2 条').first()).toBeVisible();
  for (const row of await page.locator('tr.ant-table-row').all()) await expect(row).toContainText('陈静');

  // 网页表单：官网产品咨询按分配规则 / web forms: the website form uses the rules
  await nav(page, '网页表单');
  await expect(page.getByRole('row', { name: /官网产品咨询/ })).toContainText('按分配规则');
});

test('只读用户：分配规则只能查看 / read-only users can only view the rules', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '线索');
  await page.getByTestId('assignment-open').click();
  const modal = page.getByRole('dialog', { name: '分配规则' });
  await expect(modal.getByTestId('assignment-rule').first()).toBeVisible();
  await expect(modal.getByRole('button', { name: SAVE })).toHaveCount(0);
  await expect(modal.getByTestId('assignment-add')).toHaveCount(0);
  await expect(modal.getByLabel('规则名称 1', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('bulk-assign-rule')).toHaveCount(0);
});
