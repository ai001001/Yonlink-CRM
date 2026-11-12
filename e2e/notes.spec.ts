/**
 * 备注 第三轮：端到端回归（商机详情新增 → Ctrl+Enter 提交 → 纯文本显示 HTML → 编辑 → 删除；只读用户只读）。
 * Notes round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { demoSamples } from '../prisma/demo-data';
import { nav, searchList, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('商机备注：新增、纯文本显示、编辑、删除 / deal notes: add, plain text, edit, delete', async ({ page }) => {
  await signIn(page);
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 备注客户' });
  await apiPost(page, '/api/deals', { name: 'E2E 备注商机', accountId: acc.id });

  await nav(page, '商机');
  await searchList(page, '搜索商机名称、客户名称', 'E2E 备注商机');
  await page.getByRole('button', { name: 'E2E 备注商机' }).click();
  const drawer = page.getByRole('dialog', { name: /商机详情 · E2E 备注商机/ });
  await drawer.getByRole('tab', { name: '备注' }).click();
  const panel = drawer.getByTestId('notes-panel');
  await expect(panel).toContainText('暂无备注');

  // 按钮新增 / add with the button
  await panel.getByLabel('添加备注').fill('客户要求样品下周到货\n需要加急');
  await panel.getByRole('button', { name: '添加备注' }).click();
  await expect(page.getByText('备注已添加').first()).toBeVisible();
  await expect(panel.getByTestId('note-item').first()).toContainText('客户要求样品下周到货');

  // Ctrl+Enter 新增，含 HTML 按纯文本显示 / Ctrl+Enter with HTML shown as text
  await panel.getByLabel('添加备注').fill('<b>不应加粗</b>');
  await panel.getByLabel('添加备注').press('Control+Enter');
  const newest = panel.getByTestId('note-item').first();
  await expect(newest).toContainText('<b>不应加粗</b>');
  await expect(newest.locator('b')).toHaveCount(0);
  await expect(panel.getByTestId('note-item')).toHaveCount(2);

  // 编辑 / edit
  await newest.getByRole('button', { name: /编\s*辑/ }).click();
  await newest.getByLabel('编辑').fill('改为确认后的交期：三周');
  await newest.getByRole('button', { name: /保\s*存/ }).click();
  await expect(panel.getByTestId('note-item').first()).toContainText('改为确认后的交期：三周');
  await expect(panel.getByTestId('note-item').first()).toContainText('已编辑');

  // 删除 / delete
  await panel.getByTestId('note-item').first().getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(panel.getByTestId('note-item')).toHaveCount(1);

  // 操作记录中有备注事件，正文不记录 / the activity log shows note events without the text
  await drawer.getByRole('button', { name: '关闭' }).first().click();
  await expect(drawer).toBeHidden();
  await nav(page, '审计日志');
  const table = page.locator('.ant-table');
  await expect(table).toContainText('备注 · 新建');
  await expect(table).toContainText('备注 · 删除');
  await expect(table).not.toContainText('客户要求样品下周到货');
});

test('只读用户可查看演示备注但不能添加 / read-only users see demo notes but cannot add', async ({ page }) => {
  const S = demoSamples();
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '商机');
  await searchList(page, '搜索商机名称、客户名称', S.sales2Deal);
  await page.getByRole('button', { name: S.sales2Deal }).click();
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  await drawer.getByRole('tab', { name: '备注' }).click();
  const panel = drawer.getByTestId('notes-panel');
  await expect(panel.getByTestId('note-item').first()).toContainText('【演示】');
  await expect(panel.getByLabel('添加备注')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /编\s*辑|删\s*除/ })).toHaveCount(0);
});
