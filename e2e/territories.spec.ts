/**
 * 区域管理 第三轮：端到端回归（经理：设置 › 区域管理看到演示区域树与规则 → 新建下级区域与地址条件 → 重新分配 →
 * 客户列表按区域筛选 → 客户详情显示区域 → 编辑客户手工指定区域并显示“手工指定”；销售的客户表单没有区域项）。
 * 结束时恢复自动分配并删除新建区域，避免影响共用测试库的其他用例。
 * Territories round 3: end-to-end regression on the demo data; cleans up after itself.
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

/** 以当前会话调用接口 / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 选择下拉选项（选项文字包含即可，区域选项有缩进）并按结果确认 / pick an option containing the text (territory options are indented) */
async function pick(page: Page, select: Locator, option: string) {
  const box = select.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await expect(async () => {
    if (!(await box.textContent())?.includes(option)) {
      await select.click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: option }).first().click({ timeout: 2000 });
    }
    await expect(box).toContainText(option, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

test('经理：新建区域、重新分配、按区域筛选并手工指定 / manager: create, apply, filter and set by hand', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '区域管理');
  await expect(page.getByRole('row', { name: /【演示】华东/ })).toContainText('杭州');
  await expect(page.getByRole('row', { name: /【演示】北美/ })).toContainText('王芳');
  await expect(page.getByTestId('territory-unassigned')).toContainText('无区域');

  await page.getByTestId('territory-new').click();
  const dialog = page.getByRole('dialog', { name: '新建区域' });
  await dialog.getByLabel('区域名称').fill('E2E 西南');
  await pick(page, dialog.getByLabel('上级区域', { exact: true }), '【演示】国内');
  await dialog.getByLabel('优先级').fill('5');
  await dialog.getByTestId('territory-conditions-add').click();
  await pick(page, dialog.getByLabel('字段 条件 1', { exact: true }), '地址');
  await pick(page, dialog.getByLabel('比较 条件 1', { exact: true }), '包含');
  await dialog.getByLabel('值 条件 1', { exact: true }).fill('成都');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /E2E 西南/ })).toContainText('地址 包含 “成都”');

  await page.getByTestId('territory-apply').click();
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: /确\s*定/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已检查');
  const created = (await api(page, 'GET', '/api/territories')).items.find((x: { name: string }) => x.name === 'E2E 西南');
  try {
    expect(created.stats.accounts).toBe(1);
    // 客户列表按区域筛选 / filter the account list
    await page.goto('/accounts');
    await pick(page, page.getByTestId('territory-filter').locator('input'), 'E2E 西南');
    await expect(page.locator('tr.ant-table-row')).toHaveCount(1);
    const row = page.locator('tr.ant-table-row').first();
    await expect(row).toContainText('E2E 西南');
    await row.getByRole('button').first().click();
    const drawer = page.getByRole('dialog', { name: /客户详情/ });
    await expect(drawer).toContainText('E2E 西南');
    // 编辑：手工指定区域 / edit: set the territory by hand
    await drawer.getByRole('button', { name: /编\s*辑/ }).first().click();
    const form = page.getByRole('dialog', { name: '编辑客户' });
    await pick(page, form.getByLabel('区域', { exact: true }), '【演示】海外');
    await form.getByRole('button', { name: SAVE }).click();
    await expect(form).toBeHidden();
    await expect(drawer).toContainText('【演示】海外');
    await expect(drawer).toContainText('手工指定');
  } finally {
    // 恢复：自动分配、删除新建区域、重新分配 / restore: automatic, delete the territory, apply rules
    const acc = (await api(page, 'GET', `/api/accounts?q=${encodeURIComponent('成都')}`)).items;
    for (const x of acc) await api(page, 'PATCH', `/api/accounts/${x.id}`, { territoryId: 'AUTO' });
    await api(page, 'DELETE', `/api/territories/${created.id}`);
    await api(page, 'POST', '/api/territories/apply');
  }
});

test('销售：客户表单没有区域项 / sales: no territory field on the account form', async ({ page }) => {
  await demoSignIn(page, '王芳');
  await page.goto('/accounts');
  await page.getByRole('button', { name: '新增客户' }).click();
  const form = page.getByRole('dialog', { name: '新增客户' });
  await expect(form.getByLabel('客户名称')).toBeVisible();
  await expect(form.getByLabel('区域', { exact: true })).toHaveCount(0);
});
