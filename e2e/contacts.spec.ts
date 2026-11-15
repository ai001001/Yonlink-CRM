/**
 * 联系人列表 第三轮：端到端回归（经理搜索联系人 → 详情 → 跳转所属客户；新建联系人并导出；销售代表只看自己的、无导出）。基于演示数据。
 * Contacts list round 3: end-to-end regression on the demo data.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList } from './helpers';

/** 演示账号一键登录 / demo one-click sign-in */
async function demoSignIn(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiGet(page: Page, path: string) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.get(path, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  return res.json();
}

const SEARCH = '搜索姓名、职位、电话、邮箱、客户名称';

test('经理查看、新建并导出联系人 / manager views, creates and exports contacts', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  const all = await apiGet(page, '/api/contacts?pageSize=1');
  const sample = all.items[0] as { name: string; account: { name: string } };

  await nav(page, '联系人');
  await expect(page.getByText(`共 ${all.total} 条`)).toBeVisible();
  await searchList(page, SEARCH, sample.name);
  await page.getByRole('button', { name: sample.name, exact: true }).first().click();
  const drawer = page.getByRole('dialog', { name: `联系人详情 · ${sample.name}` });
  await expect(drawer).toContainText(sample.account.name);
  await closeDrawer(page, drawer);

  // 新建（选择所属客户）/ create under a chosen account
  await page.getByRole('button', { name: '新增联系人' }).click();
  const dialog = page.getByRole('dialog', { name: '新增联系人' });
  const picked = dialog.getByTitle(sample.account.name, { exact: true });
  const option = page.locator('.ant-select-dropdown:visible').getByTitle(sample.account.name, { exact: true });
  // 下拉展开动画期间的点击可能被忽略：按结果重试 / clicks during the dropdown animation can be ignored: retry by outcome
  await expect(async () => {
    if (await picked.isVisible()) return;
    if (!(await option.isVisible())) {
      await dialog.getByLabel('所属客户').click({ timeout: 2000 });
      await dialog.getByLabel('所属客户').fill(sample.account.name.replace('【演示】', ''), { timeout: 2000 });
    }
    await option.click({ timeout: 2000 });
    await expect(picked).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await dialog.getByLabel('姓名').fill('E2E 新联系人');
  await dialog.getByLabel('职位').fill('E2E 采购');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  await searchList(page, SEARCH, 'E2E 新联系人');
  const row = page.getByRole('row', { name: /E2E 新联系人/ });
  await expect(row).toContainText(sample.account.name);

  // 导出当前搜索结果 / export the current search
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导\s*出/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^contacts-\d{8}\.csv$/);
  const content = (await readFile(await download.path())).toString('utf8');
  expect(content).toContain('E2E 新联系人,E2E 采购');

  // 从列表跳转所属客户 / jump to the account from the list
  await row.getByRole('link', { name: sample.account.name }).click();
  await expect(page).toHaveURL(/\/accounts\?id=/);
  await expect(page.getByRole('dialog', { name: /客户详情/ })).toContainText(sample.account.name);
});

test('销售代表只看到自己负责客户的联系人，没有导出 / sales reps see their own, no export', async ({ page }) => {
  await demoSignIn(page, '王芳');
  const mine = await apiGet(page, '/api/contacts?pageSize=100');
  expect(mine.items.every((c: { account: { owner: { name: string } | null } }) => c.account.owner?.name === '王芳')).toBe(true);
  await nav(page, '联系人');
  await expect(page.getByText(`共 ${mine.total} 条`)).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /导\s*出/ })).toHaveCount(0);
});
