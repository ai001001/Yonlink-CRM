/**
 * 流程蓝图 第三轮：端到端回归（经理：设置 › 流程蓝图启用演示蓝图 → 商机详情的流程面板按转换推进（填写预计成交日、金额）→
 * 编辑表单中销售阶段被锁定）。只操作本用例新建的商机，结束时停用蓝图并删除商机，避免影响共用测试库的其他用例。
 * Blueprints round 3: end-to-end regression; enables the demo blueprint only for this test and restores it.
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

/** 以当前会话调用接口 / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok(), `${method} ${path}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

test('经理：启用演示蓝图并在商机详情中按流程推进 / manager: enable the demo blueprint and move a deal', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '流程蓝图');
  const row = page.getByRole('row', { name: /【演示】商机推进流程/ });
  await expect(row).toContainText('开始需求分析');
  await expect(row).toContainText('确认赢单');
  await row.getByRole('switch').click();
  await expect.poll(async () => (await api(page, 'GET', '/api/blueprints')).items[0].isActive).toBe(true);
  const bp = (await api(page, 'GET', '/api/blueprints')).items[0];
  let dealId: string | undefined;
  try {
    const account = (await api(page, 'GET', '/api/accounts?pageSize=1')).items[0];
    const deal = await api(page, 'POST', '/api/deals', { name: 'E2E 蓝图商机', accountId: account.id });
    dealId = deal.id;
    await page.goto(`/deals?id=${deal.id}`);
    const panel = page.getByTestId('blueprint-panel');
    await expect(panel).toContainText('流程：【演示】商机推进流程');
    await expect(panel).toContainText('当前：资格确认');

    // 开始需求分析：必须填写预计成交日期 / requires the expected close date
    await panel.getByRole('button', { name: /开始需求分析/ }).click();
    const dialog = page.getByRole('dialog', { name: '执行转换“开始需求分析”' });
    await dialog.getByRole('button', { name: SAVE }).click();
    await expect(dialog.locator('.ant-form-item-explain-error').first()).toContainText('预计成交日期');
    const date = dialog.getByLabel('预计成交日期');
    await date.fill('2027-03-31');
    await date.press('Enter');
    await dialog.getByRole('button', { name: SAVE }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText('当前：需求分析');

    // 提交方案：必须填写金额 / requires the amount
    await panel.getByRole('button', { name: /提交方案/ }).click();
    const d2 = page.getByRole('dialog', { name: '执行转换“提交方案”' });
    await d2.getByLabel('商机金额').fill('50000');
    await d2.getByRole('button', { name: SAVE }).click();
    await expect(d2).toBeHidden();
    await expect(panel).toContainText('当前：方案报价');
    const fresh = await api(page, 'GET', `/api/deals/${deal.id}`);
    expect(fresh).toMatchObject({ stage: 'PROPOSAL', amount: '50000' });
    expect(fresh.expectedCloseDate.slice(0, 10)).toBe('2027-03-31');

    // 编辑表单：销售阶段被锁定 / the edit form locks the stage
    await page.getByRole('dialog', { name: /商机详情/ }).getByRole('button', { name: /编\s*辑/ }).first().click();
    const form = page.getByRole('dialog', { name: '编辑商机' });
    await expect(form).toContainText('由流程蓝图“【演示】商机推进流程”控制');
    await expect(form.locator('.ant-select-disabled').filter({ hasText: '方案报价' })).toHaveCount(1);
    await form.getByRole('button', { name: /取\s*消/ }).click();
  } finally {
    await api(page, 'PATCH', `/api/blueprints/${bp.id}`, { isActive: false });
    if (dealId) await api(page, 'DELETE', `/api/deals/${dealId}`);
  }
});
