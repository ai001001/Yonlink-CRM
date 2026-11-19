/**
 * 商机评分 第三轮：端到端回归（经理：商机列表评分列与按评分排序 → 商机评分规则新增“金额达到 ¥1,000,000 +10” → 新商机详情显示
 * 分数、分级与明细 → 看板卡片显示评分；只读用户只能查看规则）。基于演示数据。
 * Deal scoring round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, selectOption } from './helpers';

const today = new Date().toISOString().slice(0, 10);

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

/** 列表中各行的评分 / scores of the list rows */
async function rowScores(page: Page): Promise<number[]> {
  const tags = await page.locator('.ant-table-tbody').getByTestId('lead-score').allTextContents();
  return tags.map((s) => Number(s.split('·')[0]!.trim()));
}

test('经理：商机评分列表、规则与明细、看板 / manager: deal scoring', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '商机');
  await expect(page).toHaveURL(/\/deals\/?$/);

  // 按评分从高到低 / sorted by score
  await selectOption(page, page.locator('main'), '排序', '评分从高到低');
  await expect.poll(async () => (await rowScores(page)).length).toBeGreaterThan(3);
  const sorted = await rowScores(page);
  expect(sorted).toEqual([...sorted].sort((x, y) => y - x));

  // 规则：12 条，新增“金额达到 ¥1,000,000 +10” / rules: 12, add an amount tier
  await page.getByRole('button', { name: '评分规则' }).click();
  const modal = page.getByRole('dialog', { name: '评分规则' });
  await expect(modal.getByText('金额阈值按当天汇率折合人民币比较', { exact: false })).toBeVisible();
  await expect(modal.getByTestId('scoring-rules').getByLabel(/^分值 \d+$/)).toHaveCount(12);
  await modal.getByTestId('scoring-add').click();
  // 已有规则也显示“金额达到”，按结果确认：出现第 13 条的金额阈值输入框
  // existing rules also show "金额达到", so confirm by outcome: rule 13's threshold input appears
  await expect(async () => {
    if (!(await modal.getByLabel('金额阈值 13', { exact: true }).isVisible())) {
      await modal.getByLabel('规则类型 13', { exact: true }).click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible').getByTitle('金额达到', { exact: true }).click({ timeout: 2000 });
    }
    await expect(modal.getByLabel('金额阈值 13', { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await modal.getByLabel('金额阈值 13', { exact: true }).fill('1000000');
  await modal.getByLabel('分值 13', { exact: true }).fill('10');
  await modal.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText(/已保存，已重算 \d+ 条/)).toBeVisible();
  await expect(modal).toBeHidden();

  // 新商机：¥2,000,000、谈判中、有预计成交日 → 15 + 15 + 10 + 20 + 5 = 65（热门）
  // a new deal: CNY 2,000,000, negotiation, close date → 65 (hot)
  const accounts = await api(page, 'GET', `/api/accounts?q=${encodeURIComponent('华东涡轮')}`);
  const deal = await api(page, 'POST', '/api/deals', { name: 'E2E 评分大单', accountId: accounts.items[0].id, amount: '2000000', stage: 'NEGOTIATION', expectedCloseDate: today });
  expect(deal.score).toBe(65);
  await page.goto(`/deals?id=${deal.id}`);
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  await expect(drawer.getByTestId('lead-score')).toHaveText('65 · 热门');
  const items = drawer.getByTestId('lead-score-items');
  await expect(items).toContainText('金额（折合人民币）≥ ¥100,000 +15');
  await expect(items).toContainText('金额（折合人民币）≥ ¥1,000,000 +10');
  await expect(items).toContainText('阶段为商务谈判 +20');
  await closeDrawer(page, drawer);

  // 看板卡片显示评分 / board cards show scores
  await page.getByText('看板', { exact: true }).click();
  await expect(page.getByText('E2E 评分大单')).toBeVisible();
  await expect(page.locator('[data-testid=lead-score]', { hasText: '65 · 热门' }).first()).toBeVisible();
});

test('只读用户只能查看商机评分规则 / read-only users only view the deal rules', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '商机');
  await expect(page.locator('.ant-table-tbody').getByTestId('lead-score').first()).toBeVisible();
  await page.getByRole('button', { name: '评分规则' }).click();
  const modal = page.getByRole('dialog', { name: '评分规则' });
  await expect(modal.getByLabel('分值 1', { exact: true })).toBeDisabled();
  await expect(modal.getByTestId('scoring-add')).toHaveCount(0);
  await expect(modal.getByRole('button', { name: /保\s*存/ })).toHaveCount(0);
  await modal.getByRole('button', { name: /关\s*闭/ }).first().click();
  await expect(modal).toBeHidden();
});
