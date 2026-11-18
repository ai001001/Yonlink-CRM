/**
 * 客户与联系人评分 第三轮：端到端回归（经理：客户列表评分列与按评分排序 → 客户评分规则新增“已填写地址 +7” → 新客户详情显示
 * 分数、分级与明细（含联系人数）；联系人列表按“热门”筛选、联系人详情显示明细；只读用户只能查看两类规则）。基于演示数据。
 * Account and contact scoring round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, selectOption } from './helpers';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 列表中各行的评分 / scores of the list rows */
async function rowScores(page: Page): Promise<number[]> {
  const tags = await page.locator('.ant-table-tbody').getByTestId('lead-score').allTextContents();
  return tags.map((s) => Number(s.split('·')[0]!.trim()));
}

test('经理：客户评分规则与明细、联系人分级筛选 / manager: account and contact scoring', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');

  // 客户列表按评分排序 / accounts sorted by score
  await nav(page, '客户');
  await selectOption(page, page.locator('main'), '排序', '评分从高到低');
  await expect.poll(async () => (await rowScores(page)).length).toBeGreaterThan(3);
  const sorted = await rowScores(page);
  expect(sorted).toEqual([...sorted].sort((x, y) => y - x));

  // 客户评分规则：8 条，新增“已填写地址 +7” / account rules: add "address filled +7"
  await page.getByRole('button', { name: '评分规则' }).click();
  const modal = page.getByRole('dialog', { name: '评分规则' });
  await expect(modal.getByText('联系人、商机、已完成跟进变化时自动计算', { exact: false })).toBeVisible();
  await expect(modal.getByTestId('scoring-rules').getByLabel(/^分值 \d+$/)).toHaveCount(8);
  await modal.getByTestId('scoring-add').click();
  await selectOption(page, modal, '字段 9', '地址');
  await modal.getByLabel('分值 9', { exact: true }).fill('7');
  await modal.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText(/已保存，已重算 \d+ 条/)).toBeVisible();
  await expect(modal).toBeHidden();

  // 新客户：地址 7 + 电话 5 + 联系人 1×5 = 17（冷淡）/ a new account scores 17 (cold)
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 评分客户', address: 'E2E 地址', phone: '021-5550001' });
  await apiPost(page, `/api/accounts/${acc.id}/contacts`, { name: 'E2E 评分联系人', email: 'e2e-score@example.com', title: '采购经理' });
  await page.goto(`/accounts?id=${acc.id}`);
  const drawer = page.getByRole('dialog', { name: /客户详情 · E2E 评分客户/ });
  await expect(drawer.getByTestId('lead-score')).toHaveText('17 · 冷淡');
  const items = drawer.getByTestId('lead-score-items');
  await expect(items).toContainText('已填写地址 +7');
  await expect(items).toContainText('已填写电话 +5');
  await expect(items).toContainText('每个联系人（最多 3 个） +5');
  await closeDrawer(page, drawer);

  // 联系人：按“热门”筛选，详情显示明细 / contacts: hot filter, breakdown in the detail
  await page.goto('/contacts');
  await selectOption(page, page.locator('main'), '评分分级', '热门');
  // 至少一行且每行都是热门 / at least one row, every row hot
  await expect.poll(async () => {
    const tags = await page.locator('.ant-table-tbody').getByTestId('lead-score').allTextContents();
    return tags.length > 0 && tags.every((s) => s.includes('热门'));
  }).toBe(true);
  // 只取数据行（横向滚动的表格有一行隐藏的测量行）/ data rows only (scrollable tables have a hidden measure row)
  const first = page.locator('.ant-table-tbody tr.ant-table-row').first();
  await expect(first.getByTestId('lead-score')).toBeVisible();
  await first.getByRole('button').first().click();
  const contactDrawer = page.getByRole('dialog', { name: /联系人详情/ });
  await expect(contactDrawer.getByTestId('lead-score')).toContainText('热门');
  await expect(contactDrawer.getByTestId('lead-score-items')).toContainText('+');
  await closeDrawer(page, contactDrawer);
});

test('只读用户只能查看客户与联系人评分规则 / read-only users only view the rules', async ({ page }) => {
  await demoSignIn(page, '周会计');
  // 规则条数不固定（同一数据库中的其他用例可能新增规则），只检查有规则且只读
  // the rule count is not fixed (other tests in the same database may add rules); check they exist and are read-only
  for (const menu of ['客户', '联系人'] as const) {
    await nav(page, menu);
    await expect(page.locator('.ant-table-tbody').getByTestId('lead-score').first()).toBeVisible();
    await page.getByRole('button', { name: '评分规则' }).click();
    const modal = page.getByRole('dialog', { name: '评分规则' });
    await expect(modal.getByTestId('scoring-rules').getByLabel(/^分值 \d+$/).first()).toBeVisible();
    await expect(modal.getByLabel('分值 1', { exact: true })).toBeDisabled();
    await expect(modal.getByTestId('scoring-add')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: /保\s*存/ })).toHaveCount(0);
    await modal.getByRole('button', { name: /关\s*闭/ }).first().click();
    await expect(modal).toBeHidden();
  }
});
