/**
 * 线索评分 第三轮：端到端回归（经理：线索列表显示评分 → 按评分排序与按分级筛选 → 评分规则弹窗新增“已填写手机 +8”并保存，
 * 提示重算条数 → 新线索详情显示分数、分级与得分明细；只读用户只能查看规则）。基于演示数据。
 * Lead scoring round 3: end-to-end regression on the demo data.
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

test('经理：评分列表、排序筛选、修改规则与得分明细 / manager: scores, rules and breakdown', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '线索');

  // 按评分从高到低排序 / sort by score
  await selectOption(page, page.locator('main'), '排序', '评分从高到低');
  await expect.poll(async () => (await rowScores(page)).length).toBeGreaterThan(3);
  const sorted = await rowScores(page);
  expect(sorted).toEqual([...sorted].sort((x, y) => y - x));
  await expect(page.locator('.ant-table-tbody').getByTestId('lead-score').first()).toContainText('热门');

  // 按分级筛选：只剩冷淡 / filter by grade
  await selectOption(page, page.locator('main'), '评分分级', '冷淡');
  await expect.poll(async () => (await page.locator('.ant-table-tbody').getByTestId('lead-score').allTextContents()).every((s) => s.includes('冷淡'))).toBe(true);
  await expect(page.locator('.ant-table-tbody').getByTestId('lead-score').first()).toBeVisible();

  // 评分规则：新增“已填写手机 +8” / add a rule
  await page.getByRole('button', { name: '评分规则' }).click();
  const modal = page.getByRole('dialog', { name: '评分规则' });
  const rules = modal.getByTestId('scoring-rules');
  await expect(rules.getByLabel(/^分值 \d+$/)).toHaveCount(11);
  await modal.getByRole('button', { name: '添加规则' }).click();
  await selectOption(page, modal, '字段 12', '手机');
  await modal.getByLabel('分值 12', { exact: true }).fill('8');
  await modal.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText(/已保存，已重算 \d+ 条线索/)).toBeVisible();
  await expect(modal).toBeHidden();

  // 新线索：来源客户推荐 20 + 公司 10 + 电话 5 + 手机 8 = 43（温和）/ a new lead scores 43 (warm)
  const lead = await apiPost(page, '/api/leads', { name: 'E2E 评分线索', company: 'E2E 评分公司', source: 'REFERRAL', phone: '021-5550000', mobile: '13900000000' });
  expect(lead.score).toBe(43);
  await page.goto(`/leads?id=${lead.id}`);
  const drawer = page.getByRole('dialog', { name: '线索详情' });
  await expect(drawer.getByTestId('lead-score')).toHaveText('43 · 温和');
  const items = drawer.getByTestId('lead-score-items');
  await expect(items).toContainText('来源为客户推荐 +20');
  await expect(items).toContainText('已填写公司 +10');
  await expect(items).toContainText('已填写电话 +5');
  await expect(items).toContainText('已填写手机 +8');
  await closeDrawer(page, drawer);
});

test('只读用户只能查看评分规则 / read-only users only view the rules', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '线索');
  await expect(page.locator('.ant-table-tbody').getByTestId('lead-score').first()).toBeVisible();
  await page.getByRole('button', { name: '评分规则' }).click();
  const modal = page.getByRole('dialog', { name: '评分规则' });
  await expect(modal.getByLabel('分值 1', { exact: true })).toBeDisabled();
  await expect(modal.getByRole('button', { name: '添加规则' })).toHaveCount(0);
  await expect(modal.getByRole('button', { name: /保\s*存/ })).toHaveCount(0);
  await modal.getByRole('button', { name: /关\s*闭/ }).first().click();
  await expect(modal).toBeHidden();
});
