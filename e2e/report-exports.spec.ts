/**
 * 报表导出 第三轮：端到端回归（经理导出销售报表与销售预测并核对文件内容；只读用户没有导出按钮）。基于演示数据。
 * Report exports round 3: end-to-end regression on the demo data.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { nav } from './helpers';

/** 演示账号一键登录 / demo one-click sign-in */
async function demoSignIn(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 点击导出并读取下载内容 / click export and read the download */
async function exportFile(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('main').getByRole('button', { name: /导\s*出/ }).click();
  const download = await downloadPromise;
  return { name: download.suggestedFilename(), text: (await readFile(await download.path())).toString('utf8').replace(/^﻿/, '') };
}

test('经理导出销售报表与销售预测 / manager exports both reports', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await nav(page, '报表');
  await expect(page.getByTestId('reports')).toBeVisible();
  const sales = await exportFile(page);
  expect(sales.name).toMatch(/^sales-report-CNY-\d{8}-\d{8}\.csv$/);
  expect(sales.text.startsWith('销售报表\r\n币种,CNY\r\n')).toBe(true);
  for (const title of ['概览', '销售漏斗（进行中商机）', '按月赢单', '负责人排行', '线索来源转化', '报价单状态']) expect(sales.text).toContain(`\r\n\r\n${title}\r\n`);
  expect(sales.text).toContain('王芳');

  await nav(page, '销售预测');
  await expect(page.getByTestId('forecast-table')).toBeVisible();
  const forecast = await exportFile(page);
  expect(forecast.name).toMatch(/^forecast-CNY-\d{4}-\d{2}\.csv$/);
  const lines = forecast.text.trim().split('\r\n');
  expect(lines[0]).toBe('负责人,目标,已赢单,赢单数,完成率 %,距离目标,在手商机,在手商机数,加权预测,预测,预测完成率 %,最好情况');
  expect(lines.at(-1)!.startsWith('团队合计,')).toBe(true);
  expect(forecast.text).toContain('陈静');
});

test('只读用户没有报表导出按钮 / read-only users cannot export reports', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '报表');
  await expect(page.getByTestId('reports')).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /导\s*出/ })).toHaveCount(0);
  await nav(page, '销售预测');
  await expect(page.getByTestId('forecast-table')).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /导\s*出/ })).toHaveCount(0);
});
