/**
 * 导入导出 第三轮：端到端回归（导出下载并校验内容 → 上传 CSV 预检显示错误 → 确认导入 → 列表可见；销售代表无导出按钮）。
 * Import / export round 3: end-to-end regression.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { nav, searchList, signIn } from './helpers';

test('导入客户并导出 / import accounts then export', async ({ page }) => {
  await signIn(page);
  await nav(page, '客户');

  // 导入：上传 CSV → 预检 → 确认 / import: upload → dry run → confirm
  await page.getByRole('button', { name: /导\s*入/ }).click();
  const dialog = page.getByRole('dialog', { name: '导入客户' });
  const csv = [
    '客户名称,行业,电话,联系人姓名,联系人职位,联系人邮箱',
    'E2E 导入客户甲,制造业,0571-111,导入联系人,采购经理,import@example.com',
    'E2E 导入客户乙,零售,,,,',
    ',信息技术,,,,',
  ].join('\n');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'accounts.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + csv, 'utf8') });
  await expect(dialog.getByTestId('import-file')).toHaveText('accounts.csv');
  await dialog.getByRole('button', { name: /预\s*检/ }).click();
  const report = dialog.getByTestId('import-report');
  await expect(report).toContainText('共 3 行：可导入 2 条，重复 0 条，错误 1 条');
  await expect(report.getByRole('row', { name: /4/ })).toContainText('客户名称');
  await expect(report.getByRole('row', { name: /4/ })).toContainText('必填项为空');
  await dialog.getByRole('button', { name: '确认导入 2 条' }).click();
  await expect(page.getByText('已导入 2 条').first()).toBeVisible();
  await searchList(page, '搜索客户名称、电话、网站、地址、联系人', 'E2E 导入客户');
  await expect(page.getByRole('row', { name: /E2E 导入客户/ })).toHaveCount(2);

  // 导出当前搜索结果并校验文件内容 / export the current search and check the file
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导\s*出/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^accounts-\d{8}\.csv$/);
  const content = (await readFile(await download.path())).toString('utf8');
  expect(content.charCodeAt(0)).toBe(0xfeff);
  const lines = content.slice(1).trim().split('\r\n');
  expect(lines[0]).toContain('客户名称,行业');
  expect(lines).toHaveLength(3);
  expect(content).toContain('E2E 导入客户甲,制造业');
  expect(content).toContain('导入联系人');
  await expect(page.getByText('已导出 2 条').first()).toBeVisible();
});

test('销售代表可导入但没有导出按钮 / sales reps can import but not export', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 王芳' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('销售代表');
  await nav(page, '线索');
  await expect(page.getByRole('button', { name: /导\s*入/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /导\s*出/ })).toHaveCount(0);
});
