/**
 * 附件 第三轮：端到端回归（商机详情上传 → 不允许的类型被拒 → 下载内容一致 → 删除；线索详情区块；只读用户只能下载演示附件）。
 * Attachments round 3: end-to-end regression.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildDemoData } from '../prisma/demo-data';
import { closeDrawer, nav, searchList, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

const PDF = Buffer.from('%PDF-1.4\n% E2E 演示报价\n');

test('商机附件：上传、类型限制、下载、删除 / deal attachments', async ({ page }) => {
  // 步骤较多（含两次上传与一次下载）/ a longer flow with uploads and a download
  test.setTimeout(60_000);
  await signIn(page);
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 附件客户' });
  await apiPost(page, '/api/deals', { name: 'E2E 附件商机', accountId: acc.id });
  await nav(page, '商机');
  await searchList(page, '搜索商机名称、客户名称', 'E2E 附件商机');
  await page.getByRole('button', { name: 'E2E 附件商机' }).click();
  const drawer = page.getByRole('dialog', { name: /商机详情 · E2E 附件商机/ });
  await drawer.getByRole('tab', { name: '附件' }).click();
  const panel = drawer.getByTestId('attachments-panel');
  await expect(panel).toContainText('暂无附件');
  await expect(panel).toContainText('单个文件不超过 10.0 MB');

  // 上传 / upload
  await panel.locator('input[type=file]').setInputFiles({ name: 'E2E 报价.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByText('已上传：E2E 报价.pdf').first()).toBeVisible();
  const item = panel.getByTestId('attachment-item').filter({ hasText: 'E2E 报价.pdf' });
  await expect(item).toContainText(`${PDF.byteLength} B`);
  await expect(item).toContainText('系统管理员');

  // 不允许的类型 / disallowed type
  await panel.locator('input[type=file]').setInputFiles({ name: 'evil.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') });
  await expect(page.getByText('不支持该文件类型').first()).toBeVisible();
  await expect(panel.getByTestId('attachment-item')).toHaveCount(1);

  // 下载内容一致 / download matches
  const [download] = await Promise.all([page.waitForEvent('download'), item.getByRole('button', { name: /下载/ }).click()]);
  expect(download.suggestedFilename()).toBe('E2E 报价.pdf');
  expect(readFileSync(await download.path())).toEqual(PDF);

  // 删除 / delete
  await item.getByRole('button', { name: /删\s*除/ }).click();
  await expect(page.locator('.ant-popover:visible')).toContainText('删除附件“E2E 报价.pdf”？');
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(panel).toContainText('暂无附件');
  await closeDrawer(page, drawer);
  await expect(drawer).toBeHidden();

  // 线索详情也有附件区块 / leads have an attachments section too
  await apiPost(page, '/api/leads', { name: 'E2E 附件线索' });
  await nav(page, '线索');
  await searchList(page, '搜索姓名、公司、邮箱、电话', 'E2E 附件线索');
  await page.getByRole('button', { name: 'E2E 附件线索' }).click();
  const leadDrawer = page.getByRole('dialog', { name: /线索详情/ });
  const leadPanel = leadDrawer.getByTestId('attachments-panel');
  await leadPanel.locator('input[type=file]').setInputFiles({ name: '名片.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E 名片') });
  await expect(leadPanel.getByTestId('attachment-item')).toContainText('名片.txt');
  await closeDrawer(page, leadDrawer);
  await expect(leadDrawer).toBeHidden();

  // 审计 / audit
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table:visible').first()).toContainText('附件');
});

test('只读用户：可下载演示附件，不能上传或删除 / read-only users only download', async ({ page }) => {
  const account = buildDemoData().accounts[0]!.name;
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '客户');
  await searchList(page, '搜索客户名称、电话、网站、地址、联系人', account);
  await page.getByRole('button', { name: account }).click();
  const drawer = page.getByRole('dialog', { name: /客户详情/ });
  await drawer.getByRole('tab', { name: '附件' }).click();
  const panel = drawer.getByTestId('attachments-panel');
  const item = panel.getByTestId('attachment-item').filter({ hasText: '产品价格表（演示）.csv' });
  await expect(item).toBeVisible();
  await expect(panel.getByRole('button', { name: '上传附件' })).toHaveCount(0);
  await expect(item.getByRole('button', { name: /删\s*除/ })).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), item.getByRole('button', { name: /下载/ }).click()]);
  expect(download.suggestedFilename()).toBe('产品价格表（演示）.csv');
  expect(readFileSync(await download.path(), 'utf8')).toContain('SKU,产品,单位,单价,币种');
});
