/**
 * 市场活动 第三轮：端到端回归（经理查看演示活动统计 → 新建活动 → 新建线索并选择来源活动 → 线索列表按活动筛选 →
 * 活动详情计入该线索 → 有关联时不能删除；只读用户没有新建按钮）。基于演示数据。
 * Campaigns round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList } from './helpers';

/** 演示账号一键登录 / demo one-click sign-in */
async function demoSignIn(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/**
 * 在下拉中选择活动，按结果重试（下拉展开动画期间的点击可能被忽略）。
 * Pick a campaign, retrying by outcome (clicks during the dropdown animation can be ignored).
 */
async function pickCampaign(page: Page, scope: Locator, label: string, name: string) {
  const picked = scope.getByTitle(name, { exact: true });
  const option = page.locator('.ant-select-dropdown:visible').getByTitle(name, { exact: true });
  await expect(async () => {
    if (await picked.isVisible()) return;
    if (!(await option.isVisible())) await scope.getByLabel(label).click({ timeout: 2000 });
    await option.click({ timeout: 2000 });
    await expect(picked).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
}

const NAME = 'E2E 新品发布会';

test('经理管理市场活动并关联线索 / manager runs a campaign', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await nav(page, '市场活动');
  const expo = page.getByRole('row', { name: /2026 上海国际汽配展/ });
  await expect(expo).toContainText('已完成');
  await expo.getByRole('button', { name: /2026 上海国际汽配展/ }).click();
  const drawer = page.getByRole('dialog', { name: /活动详情 · 【演示】2026 上海国际汽配展/ });
  await expect(drawer.getByTestId('campaign-linked-leads')).toContainText('【演示】');
  await expect(drawer.getByTestId('campaign-roi')).toContainText('%');
  await closeDrawer(page, drawer);

  // 新建活动 / create a campaign
  await page.getByRole('button', { name: '新建活动' }).click();
  const form = page.getByRole('dialog', { name: '新建活动' });
  await form.getByLabel('活动名称').fill(NAME);
  await form.getByLabel('实际花费').fill('5000');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('row', { name: new RegExp(NAME) })).toContainText('计划中');

  // 新建线索并选择来源活动 / a lead from the campaign
  await nav(page, '线索');
  await page.getByRole('button', { name: '新增线索' }).click();
  const leadForm = page.getByRole('dialog', { name: '新增线索' });
  await leadForm.getByLabel('姓名').fill('E2E 活动线索');
  await pickCampaign(page, leadForm, '来源市场活动', NAME);
  await leadForm.getByRole('button', { name: /保\s*存/ }).click();
  await expect(leadForm).toBeHidden();
  await pickCampaign(page, page.getByRole('main'), '按市场活动筛选', NAME);
  await expect(page.getByText('共 1 条')).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 活动线索/ })).toBeVisible();

  // 活动详情计入该线索；有关联不能删除 / the campaign counts it and cannot be deleted
  await nav(page, '市场活动');
  await searchList(page, '搜索活动名称或说明', NAME);
  const row = page.getByRole('row', { name: new RegExp(NAME) });
  await expect(row).toContainText('1 / 0');
  await row.getByRole('button', { name: /删\s*除/ }).click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByText('该活动已有关联的线索或商机，不能删除；可将状态改为“已取消”')).toBeVisible();
  await expect(row).toBeVisible();
});

test('只读用户只能查看市场活动 / read-only users only view', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '市场活动');
  await expect(page.getByRole('row', { name: /海外社媒推广/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建活动' })).toHaveCount(0);
  await expect(page.getByText('只有管理员和经理可以新建、编辑和删除市场活动。')).toBeVisible();
});
