/**
 * 报价单审批 第三轮：端到端回归（经理：审批页看到演示规则与待审批报价单，批准后状态变为已批准；销售：自己的草稿报价单发送被拦、
 * 提交审批后锁定并出现在“我提交的”；只读用户：审批规则只读、没有“待我审批”）。基于演示数据。
 * Quote approvals round 3: end-to-end regression on the demo data.
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
async function api(page: Page, path: string) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.get(path, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('经理：在审批页批准待审批报价单 / manager approves a pending quote', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await nav(page, '审批');
  const settings = page.getByTestId('approval-settings');
  await expect(settings.getByRole('switch')).toBeChecked();
  await expect(settings.getByLabel('折扣上限')).toHaveValue('5.00');
  const row = page.locator('tr.ant-table-row').filter({ hasText: '待审批' }).first();
  await expect(row).toContainText('陈静');
  await expect(row).toContainText('折扣 8% 超过上限 5%');
  const number = (await row.locator('td').first().innerText()).trim();
  await row.getByRole('button', { name: /批\s*准/ }).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`批准 · ${number}`) });
  await dialog.getByLabel('审批意见').fill('E2E 同意');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByText('已批准').first()).toBeVisible();
  await expect(page.locator('tr.ant-table-row').filter({ hasText: number })).toHaveCount(0);
  // 报价单详情：已批准与审批历史 / the quote shows the approval and history
  const quotes = await api(page, `/api/quotes?q=${number}`);
  await page.goto(`/quotes?id=${quotes.items[0].id}`);
  const panel = page.getByTestId('quote-approval');
  await expect(panel.getByTestId('approval-status')).toHaveText('已批准');
  await expect(panel.getByTestId('approval-history')).toContainText('E2E 同意');
});

test('销售：发送被拦、提交审批后锁定 / sales rep submits a quote for approval', async ({ page }) => {
  await demoSignIn(page, '王芳');
  const drafts = await api(page, '/api/quotes?status=DRAFT&pageSize=50');
  const mine = drafts.items.find((q: { approvalStatus: string | null; createdBy: { name: string } | null }) => q.approvalStatus === null && q.createdBy?.name === '王芳');
  expect(mine).toBeTruthy();
  await page.goto(`/quotes?id=${mine.id}`);
  const drawer = page.getByRole('dialog', { name: new RegExp(mine.quoteNumber) });
  // 直接发送被拦 / sending is blocked
  await drawer.getByRole('button', { name: '发送' }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).last().click();
  await expect(page.getByText(/需要审批批准后才能发送/)).toBeVisible();
  // 提交审批 / submit
  await drawer.getByTestId('approval-submit').click();
  const dialog = page.getByRole('dialog', { name: '提交审批' });
  await dialog.getByLabel('审批意见').fill('E2E 申请大额报价');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(drawer.getByTestId('approval-status').first()).toHaveText('待审批');
  await expect(drawer.getByText('报价单正在审批中')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '编辑' })).toHaveCount(0);
  await expect(drawer.getByTestId('approval-recall')).toBeVisible();
  // 我提交的 / my submissions
  await page.goto('/approvals');
  await expect(page.getByText('待我审批')).toHaveCount(0);
  await expect(page.locator('tr.ant-table-row').filter({ hasText: mine.quoteNumber })).toContainText('待审批');
});

test('只读用户：审批规则只读 / read-only users only view the policy', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '审批');
  await expect(page.getByTestId('approval-settings').getByRole('switch')).toBeDisabled();
  await expect(page.getByTestId('approval-settings').getByRole('button', { name: SAVE })).toHaveCount(0);
  await expect(page.getByText('待我审批')).toHaveCount(0);
});
