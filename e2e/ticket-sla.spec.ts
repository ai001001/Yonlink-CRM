/**
 * 工单 SLA 超时升级 第三轮：端到端回归（演示经理：已逾期工单显示“已升级”并可筛选 → 通知中心收到升级通知 →
 * 修改 SLA 时限 → 新建紧急工单不填期限，按 SLA 自动计算；只读用户看不到 SLA 设置）。基于演示数据。
 * Ticket SLA escalation round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, pickRecord, selectOption } from './helpers';

const SAVE = /保\s*存/;

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('经理查看升级、修改 SLA、自动期限 / manager: escalations, policy, automatic due', async ({ page }) => {
  test.setTimeout(60_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '服务工单');
  // 已逾期的演示工单已升级 / overdue demo tickets are escalated
  await page.getByRole('checkbox', { name: '只看已升级' }).check();
  const urgent = page.getByRole('row', { name: /批次到货外包装破损/ });
  await expect(urgent).toContainText('已升级');
  await expect(page.getByRole('row', { name: /涡轮增压器异响/ })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '只看已升级' }).uncheck();

  // SLA 设置 / SLA settings
  await page.getByRole('button', { name: 'SLA 设置' }).click();
  const modal = page.getByRole('dialog', { name: 'SLA 设置' });
  await expect(modal.getByRole('switch', { name: '启用 SLA' })).toBeChecked();
  await expect(modal.getByTitle('郑经理')).toBeVisible();
  await modal.getByLabel('紧急（小时）').fill('6');
  await modal.getByRole('button', { name: SAVE }).click();
  await expect(modal).toBeHidden();

  // 新建紧急工单不填期限 / a new urgent ticket without a due time
  await page.getByRole('button', { name: '新建工单' }).click();
  const form = page.getByRole('dialog', { name: '新建工单' });
  await expect(form).toContainText('留空时按 SLA 规则自动计算');
  await form.getByLabel('主题').fill('E2E SLA 自动期限');
  await pickRecord(page, form, '客户', '东北客车', '【演示】东北客车动力维修公司');
  await selectOption(page, form, '优先级', '紧急');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form).toBeHidden();
  await page.getByRole('row', { name: /E2E SLA 自动期限/ }).getByRole('button', { name: 'E2E SLA 自动期限' }).click();
  const due = page.getByRole('dialog', { name: /工单详情/ }).getByTestId('ticket-due');
  await expect(due).toContainText('（按 SLA 自动）');
  // 期限约为 6 小时后 / due in about six hours
  const text = (await due.innerText()).slice(0, 16);
  // 页面按浏览器时区显示，因此在浏览器中解析 / the page shows browser-local time, so parse it in the browser
  const dueMs = await page.evaluate((s) => new Date(`${s.replace(' ', 'T')}:00`).getTime(), text);
  const hoursAhead = (dueMs - Date.now()) / 3_600_000;
  expect(hoursAhead).toBeGreaterThan(5.9);
  expect(hoursAhead).toBeLessThan(6.1);

  // 通知中心 / notification centre
  await page.goto('/notifications');
  await expect(page.getByRole('link', { name: /工单 CS-\d{4}-\d{4} 【演示】批次到货外包装破损，需补发 2 件 已超过处理期限，已升级/ })).toBeVisible();
});

test('只读用户看不到 SLA 设置 / read-only users cannot change the SLA', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '服务工单');
  await expect(page.getByRole('row', { name: /批次到货外包装破损/ })).toContainText('已升级');
  await expect(page.getByRole('button', { name: 'SLA 设置' })).toHaveCount(0);
});
