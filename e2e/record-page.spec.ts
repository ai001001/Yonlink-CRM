/**
 * 整页详情 端到端（第一轮界面功能，第三轮回归）：经理从商机抽屉进入整页，点字段直接修改描述与阶段、清空名称时不能保存，
 * 时间线出现修改记录；客户整页显示联系人与商机页签；线索整页直接修改公司；区域只读的记录没有编辑按钮并显示提示；
 * 手机宽度不超宽。用例修改的是自己新建的商机与线索，不改演示数据。
 * Full-page detail end to end: drawer → full page, in-place edits, timeline, read-only territory records, phone width.
 */
import { expect, test, type Page } from '@playwright/test';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 用当前会话调用接口 / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 某字段所在的行 / the row of a field */
const fieldRow = (page: Page, label: string) => page.getByTestId('record-field').filter({ hasText: label }).first();

test('经理：从抽屉进入商机整页，直接修改字段，时间线出现修改记录 / manager edits a deal in place', async ({ page }) => {
  test.setTimeout(90_000);
  await demoSignIn(page, '郑经理');
  const acct = (await api(page, 'GET', '/api/accounts?pageSize=1')).items[0];
  const deal = await api(page, 'POST', '/api/deals', { name: 'E2E 整页商机', accountId: acct.id, amount: '1000' });
  await page.goto(`/deals?id=${deal.id}`);
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  await drawer.getByTestId('open-full-page').click();
  await expect(page).toHaveURL(/\/deals\/view\/?\?id=/);
  await expect(page.getByTestId('record-title')).toHaveText('E2E 整页商机');

  // 描述：点击后编辑并保存 / description: click to edit and save
  await fieldRow(page, '备注').getByRole('button', { name: /编辑/ }).click();
  const box = page.getByRole('textbox', { name: '备注', exact: true });
  await box.fill('E2E 直接修改的描述');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('E2E 直接修改的描述')).toBeVisible();

  // 阶段：下拉选择 / stage via a select
  await fieldRow(page, '销售阶段').getByRole('button', { name: /编辑/ }).click();
  await page.getByRole('combobox', { name: '销售阶段' }).click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('商务谈判', { exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('record-page').locator('.ant-tag').filter({ hasText: '商务谈判' })).toBeVisible();

  // 名称必填：清空后不能保存 / the name is required
  await fieldRow(page, '商机名称').getByRole('button', { name: /编辑/ }).click();
  await page.getByRole('textbox', { name: '商机名称' }).fill('');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();

  // 时间线：两次修改与新建 / timeline: two edits and the creation
  const timeline = page.getByTestId('record-timeline');
  await expect(timeline.getByTestId('timeline-item').filter({ hasText: '修改' })).toHaveCount(3);
  await expect(timeline).toContainText('商务谈判');
});

test('客户与线索整页 / account and lead full pages', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  const acct = (await api(page, 'GET', '/api/accounts?pageSize=1')).items[0];
  await page.goto(`/accounts/view?id=${acct.id}`);
  await expect(page.getByTestId('record-title')).toHaveText(acct.name);
  await expect(page.getByRole('tab', { name: /联系人/ })).toBeVisible();
  await page.getByRole('tab', { name: /商机/ }).click();
  await expect(page.getByTestId('account-deals')).toBeVisible();
  const lead = await api(page, 'POST', '/api/leads', { name: 'E2E 整页线索' });
  await page.goto(`/leads/view?id=${lead.id}`);
  await fieldRow(page, '公司').getByRole('button', { name: /编辑/ }).click();
  await page.getByRole('textbox', { name: '公司' }).fill('E2E 公司');
  await page.getByRole('textbox', { name: '公司' }).press('Enter');
  await expect(fieldRow(page, '公司')).toContainText('E2E 公司');
});

test('区域只读的记录：没有编辑按钮并显示提示；手机宽度不超宽 / read-only territory records; phone width', async ({ page }) => {
  await demoSignIn(page, '王芳');
  // 王芳所在的海外区域中陈静负责的商机 / a deal of 陈静 inside 王芳's overseas territory
  const list = await api(page, 'GET', '/api/deals?pageSize=100');
  const other = list.items.find((d: { owner: { name: string } | null }) => d.owner?.name === '陈静');
  await page.goto(`/deals/view?id=${other.id}`);
  await expect(page.getByTestId('record-title')).toHaveText(other.name);
  await expect(page.getByText('你可以查看这条记录，但只有负责人或有编辑全部权限的角色能修改')).toBeVisible();
  await expect(page.getByTestId('record-field').getByRole('button', { name: /编辑/ })).toHaveCount(0);
  await expect(page.getByTestId('record-timeline').or(page.getByText('暂无记录'))).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('record-title')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
