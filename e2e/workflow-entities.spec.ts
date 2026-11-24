/**
 * 客户与工单工作流 第三轮：端到端回归（经理：工作流规则页看到客户与工单的演示规则 → 新建“服务工单”规则，触发时机里没有
 * “无跟进” → 优先级变为紧急时通知 → 修改工单优先级后收到通知 → 停用规则）。结束时停用新建的规则，避免影响其他用例。
 * Account and ticket workflows round 3: end-to-end regression; disables its rule afterwards.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { nav } from './helpers';

const SAVE = /保\s*存/;


/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/**
 * 在弹窗内按标签选择下拉选项，按结果确认（下拉框显示该选项）。
 * Pick an option in a dialog select by label and confirm by outcome (the select shows it).
 */
async function pick(page: Page, scope: Locator, label: string, option: string) {
  const select = scope.getByLabel(label, { exact: true });
  // 该输入框所在的下拉框根元素（同名选项可能出现在多个下拉框中，只看这一个）/ the select root of this input only
  const box = select.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await expect(async () => {
    if (!(await box.textContent())?.includes(option)) {
      await select.click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click({ timeout: 2000 });
    }
    await expect(box).toContainText(option, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

test('经理：新建服务工单的工作流规则并触发 / manager: a ticket workflow rule fires', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '工作流规则');
  await expect(page.getByRole('row', { name: /【演示】工单升为紧急：通知经理/ })).toContainText('服务工单');
  await expect(page.getByRole('row', { name: /【演示】新客户：安排首次拜访/ })).toContainText('客户');

  await page.getByRole('button', { name: '新建工作流规则' }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作流规则' });
  await dialog.getByLabel('规则名称').fill('E2E 工单升紧急');
  await pick(page, dialog, '对象', '服务工单');
  // 服务工单没有“无跟进”触发 / tickets offer no inactivity trigger
  await dialog.getByLabel('触发时机').click();
  await expect(page.locator('.ant-select-dropdown:visible').getByTitle('无跟进（定时）', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await pick(page, dialog, '触发时机', '指定字段变化时');
  await pick(page, dialog, '变化的字段', '优先级');
  await dialog.getByTestId('workflow-add-condition').click();
  await pick(page, dialog, '字段 1', '优先级');
  await pick(page, dialog, '值 1', '紧急');
  await dialog.getByLabel('提醒内容 1', { exact: true }).fill('E2E 工单升为紧急');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 工单升紧急/ });
  await expect(row).toContainText('优先级变化时');
  await expect(row).toContainText('优先级 等于 紧急');
  const rule = (await api(page, 'GET', '/api/workflows?entity=TICKET')).items.find((r: { name: string }) => r.name === 'E2E 工单升紧急');
  try {
    const account = (await api(page, 'GET', '/api/accounts?pageSize=1')).items[0];
    const me = await api(page, 'GET', '/api/auth/me');
    const ticket = await api(page, 'POST', '/api/tickets', { subject: 'E2E 工作流工单', accountId: account.id, ownerId: me.id });
    await api(page, 'PATCH', `/api/tickets/${ticket.id}`, { priority: 'URGENT' });
    const notes = await api(page, 'GET', '/api/notifications?pageSize=50');
    expect(notes.items.some((n: { type: string; title: string }) => n.type === 'WORKFLOW' && n.title === `E2E 工单升为紧急 · ${ticket.ticketNumber} E2E 工作流工单`)).toBe(true);
  } finally {
    await api(page, 'PATCH', `/api/workflows/${rule.id}`, { isActive: false });
  }
});
