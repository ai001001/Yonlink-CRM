/**
 * 多级审批 第三轮：端到端回归（经理：审批规则显示 2 个演示级别；
 * 王芳提交大额报价后经理看到“管理员复核”但不能审批；管理员林管理批准后完成）。基于演示数据。
 * Multi-level approval round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const SAVE = /保\s*存/;

/** 在新的浏览器上下文中以演示账号登录 / sign in as a demo user in a fresh context */
async function demoPage(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
  return page;
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('多级审批：经理级、管理员级逐级处理 / levels handled by the right roles', async ({ browser }) => {
  test.setTimeout(150_000);
  const manager = await demoPage(browser, '郑经理');
  await manager.goto('/approvals');
  const levels = manager.getByTestId('approval-levels');
  await expect(levels.getByLabel('级别名称 1', { exact: true })).toHaveValue('经理审批');
  await expect(levels.getByLabel('级别名称 2', { exact: true })).toHaveValue('管理员复核');

  // 王芳提交自己的大额草稿报价：只需管理员复核 / 王芳 submits her large draft: admin review only
  const rep = await demoPage(browser, '王芳');
  // 用王芳大额报价所在的商机新生成一张报价单（不依赖其他用例留下的状态）/ a fresh quote from 王芳's large deal (independent of other specs)
  const drafts = await api(rep, 'GET', '/api/quotes?status=DRAFT&pageSize=50');
  const large = drafts.items.find((q: { total: string; currency: string; createdBy: { name: string } | null }) => q.createdBy?.name === '王芳' && q.currency === 'USD' && Number(q.total) > 100000);
  const mine = await api(rep, 'POST', '/api/quotes', { dealId: large.dealId });
  const r = await api(rep, 'POST', `/api/quotes/${mine.id}/approval/submit`, {});
  expect(r.steps).toEqual([{ name: '管理员复核', role: 'ADMIN' }]);

  // 经理看到但不能审批 / the manager sees it but cannot decide
  await manager.reload();
  const row = manager.locator('tr.ant-table-row').filter({ hasText: mine.quoteNumber });
  await expect(row).toContainText('第 1/1 级 · 管理员复核（管理员）');
  await expect(row).toContainText('需由当前级别的其他审批人处理');
  await expect(row.getByRole('button', { name: /批\s*准/ })).toHaveCount(0);

  // 管理员批准 / the admin approves
  const admin = await demoPage(browser, '林管理');
  await admin.goto('/approvals');
  const adminRow = admin.locator('tr.ant-table-row').filter({ hasText: mine.quoteNumber });
  await adminRow.getByRole('button', { name: /批\s*准/ }).click();
  const dialog = admin.getByRole('dialog', { name: new RegExp(`批准 · ${mine.quoteNumber}`) });
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(admin.locator('tr.ant-table-row').filter({ hasText: mine.quoteNumber })).toHaveCount(0);
  const detail = await api(rep, 'GET', `/api/quotes/${mine.id}`);
  expect(detail).toMatchObject({ approvalStatus: 'APPROVED', approvalStep: null });
});
