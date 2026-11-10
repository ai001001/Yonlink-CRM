/**
 * 审计日志 第三轮：端到端回归（界面操作 → 详情操作记录 → 审计日志页筛选 → 脱敏显示 → 登录事件）。
 * Audit log round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { nav, signIn } from './helpers';

const SAVE = /保\s*存/;

test('审计日志完整流程 / full audit flow', async ({ page }) => {
  await signIn(page);

  // 通过界面新建并修改线索 / create and edit a lead in the UI
  await nav(page, '线索');
  await page.getByRole('button', { name: '新增线索' }).click();
  let dialog = page.getByRole('dialog', { name: '新增线索' });
  await dialog.getByLabel('姓名').fill('E2E 审计线索');
  await dialog.getByLabel('邮箱').fill('audit.person@example.com');
  await dialog.getByLabel('备注').fill('E2E 机密备注内容');
  await dialog.getByRole('button', { name: SAVE }).click();
  const row = page.getByRole('row', { name: /E2E 审计线索/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑线索' });
  await dialog.getByLabel('线索状态').click();
  await page.getByTitle('已联系').click();
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(row).toContainText('已联系');

  // 详情中的操作记录 / activity log in the detail drawer
  await row.getByRole('button', { name: 'E2E 审计线索' }).click();
  const drawer = page.getByRole('dialog', { name: '线索详情' });
  const trail = drawer.getByTestId('audit-trail');
  await expect(trail).toContainText('线索 · 新建');
  await expect(trail).toContainText('线索 · 修改');
  await expect(trail).toContainText('线索状态：新线索 → 已联系');
  await expect(trail).toContainText('a***@example.com');
  await expect(trail).toContainText('（已修改，内容不记录）');
  await expect(trail).not.toContainText('audit.person@example.com');
  await expect(trail).not.toContainText('E2E 机密备注内容');
  await drawer.getByRole('button', { name: '关闭' }).first().click();

  // 审计日志页：说明、筛选、登录事件 / audit page: notice, filters, login events
  await nav(page, '审计日志');
  await expect(page.getByText('审计日志只能追加，任何人都无法修改或删除；敏感信息已脱敏。')).toBeVisible();
  const table = page.locator('.ant-table');
  await expect(table).toContainText('线索 · 修改');
  await expect(table).toContainText('登录 · 登录成功');
  await page.getByRole('combobox').first().click();
  await page.getByTitle('登录', { exact: true }).click();
  await expect(table).toContainText('登录 · 登录成功');
  await expect(table).not.toContainText('线索 · 新建');
  await page.getByRole('combobox').first().click();
  await page.getByTitle('线索', { exact: true }).click();
  await expect(table).toContainText('线索 · 新建');
  await expect(table).not.toContainText('登录 · 登录成功');
  await expect(page.getByRole('main')).not.toContainText('audit.person@example.com');
});
