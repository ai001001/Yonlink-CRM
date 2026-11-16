/**
 * 工单导出 CSV 第三轮：端到端回归（经理按“未解决 + 紧急”筛选后导出，文件名、BOM、表头与内容和列表一致；
 * 只读用户看不到导出按钮）。基于演示数据。
 * Ticket CSV export round 3: end-to-end regression on the demo data.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { nav, selectOption } from './helpers';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('经理按筛选导出工单 / manager exports filtered tickets', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  await nav(page, '服务工单');
  const main = page.getByRole('main');
  await selectOption(page, main, '优先级', '紧急');
  const row = page.getByRole('row', { name: /批次到货外包装破损/ });
  await expect(row).toBeVisible();
  await expect(page.getByText('共 1 条')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导\s*出/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^tickets-\d{8}\.csv$/);
  const content = (await readFile(await download.path())).toString('utf8');
  expect(content.charCodeAt(0)).toBe(0xfeff);
  const lines = content.slice(1).trim().split('\r\n');
  expect(lines[0]).toMatch(/^工单号,主题,客户,联系人,电话,邮箱,类型,来源渠道,优先级,状态,已逾期,负责人,/);
  // 与列表一致：只有一张未解决的紧急工单 / matches the list: a single unresolved urgent ticket
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(/^CS-\d{4}-\d{4},【演示】批次到货外包装破损，需补发 2 件,/);
  expect(lines[1]).toContain(',紧急,新建,是,陈静,');
  await expect(page.getByText('已导出 1 条')).toBeVisible();
});

test('只读用户看不到导出按钮 / read-only users cannot export', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '服务工单');
  await expect(page.getByRole('row', { name: /涡轮增压器异响/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /导\s*出/ })).toHaveCount(0);
});
