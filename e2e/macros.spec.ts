/**
 * 宏 第三轮：端到端回归（经理：设置 › 宏看到共享演示宏、看不到王芳的个人宏 → 新建个人宏（改状态 + 加标签）→
 * 在线索详情中运行；王芳：列表勾选两条自己的线索 → 批量栏运行个人演示宏）。只操作本用例新建的记录，结束时删除新建的宏。
 * Macros round 3: end-to-end regression; only touches records it creates and deletes its macro afterwards.
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

/** 以当前会话调用接口 / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST' | 'DELETE', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.status() === 204 ? null : res.json();
}

/** 选择下拉选项并按结果确认 / pick an option, confirmed by outcome */
async function pick(page: Page, select: Locator, option: string) {
  const box = select.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await expect(async () => {
    if (!(await box.textContent())?.includes(option)) {
      await select.click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click({ timeout: 2000 });
    }
    await expect(box).toContainText(option, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/** 在“运行宏”下拉中选择宏并确认 / choose a macro in the run picker and confirm */
async function runMacro(page: Page, scope: Locator, name: string) {
  await expect(async () => {
    await scope.getByLabel('运行宏').click({ timeout: 2000 });
    await page.locator('.ant-select-dropdown:visible').getByTitle(name, { exact: true }).click({ timeout: 2000 });
    await expect(page.locator('.ant-modal-confirm-title')).toContainText(name, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '运行宏' }).click();
}

test('经理：新建个人宏并在线索详情中运行 / manager: create a personal macro and run it from a lead', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '宏');
  await expect(page.getByRole('row', { name: /【演示】已联系并安排回访/ })).toContainText('共享');
  await expect(page.getByRole('row', { name: /【演示】展会线索整理/ })).toHaveCount(0);

  await page.getByTestId('macro-new').click();
  const dialog = page.getByRole('dialog', { name: '新建宏' });
  await dialog.getByLabel('宏名称').fill('E2E 确认并标记重点');
  await pick(page, dialog.getByLabel('新值 1', { exact: true }), '已确认');
  await dialog.getByTestId('macro-add-action').click();
  await pick(page, dialog.getByLabel('标签 2', { exact: true }), '重点客户');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 确认并标记重点/ });
  await expect(row).toContainText('线索状态改为已确认');
  await expect(row).toContainText('加标签“重点客户”');
  const macro = (await api(page, 'GET', '/api/macros?entity=LEAD')).items.find((m: { name: string }) => m.name === 'E2E 确认并标记重点');
  try {
    const lead = await api(page, 'POST', '/api/leads', { name: 'E2E 宏线索' });
    await page.goto(`/leads?id=${lead.id}`);
    const drawer = page.getByRole('dialog', { name: /线索详情/ });
    await expect(drawer).toContainText('E2E 宏线索');
    await runMacro(page, drawer, 'E2E 确认并标记重点');
    await expect(page.locator('.ant-message')).toContainText('已对 1 条记录执行完成');
    await expect(drawer).toContainText('已确认');
    await expect(drawer).toContainText('重点客户');
    await api(page, 'DELETE', `/api/leads/${lead.id}`);
  } finally {
    await api(page, 'DELETE', `/api/macros/${macro.id}`);
  }
});

test('王芳：列表勾选两条线索，批量栏运行个人宏 / sales: run a personal macro from the bulk bar', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '王芳');
  const created = [];
  for (const n of ['甲', '乙']) created.push(await api(page, 'POST', '/api/leads', { name: `E2E 宏批量${n}` }));
  {
    await page.goto('/leads');
    await page.getByPlaceholder('搜索姓名、公司、邮箱、电话').fill('E2E 宏批量');
    await page.getByPlaceholder('搜索姓名、公司、邮箱、电话').press('Enter');
    await expect(page.getByRole('row', { name: /E2E 宏批量/ })).toHaveCount(2);
    await page.locator('thead .ant-checkbox-input').check();
    const bar = page.getByTestId('bulk-bar');
    await expect(bar).toContainText('已选择 2 条');
    await runMacro(page, bar, '【演示】展会线索整理');
    await expect(page.locator('.ant-message')).toContainText('已对 2 条记录执行完成');
    for (const l of created) {
      const fresh = await api(page, 'GET', `/api/leads/${l.id}`);
      expect(fresh.source).toBe('EXHIBITION');
      expect(fresh.tags.map((x: { tag: { name: string } }) => x.tag.name)).toContain('展会线索');
    }
  }
  // 销售没有删除权限，新建的 E2E 线索保留在测试库中（名称带 E2E 前缀）/ sales cannot delete; the E2E leads stay in the test database
});
