/**
 * 销售节奏 第三轮：端到端回归（经理：设置 › 销售节奏看到演示节奏与参与数 → 新建两步节奏 → 在线索详情中加入，
 * 第 0 天的电话立即创建，面板显示进度 → 停止）。只操作本用例新建的记录，结束时删除新建的节奏与线索。
 * Cadences round 3: end-to-end regression; only touches records it creates and deletes them afterwards.
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
  expect(res.ok(), `${method} ${path}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

/** 在下拉中选择并按结果确认 / pick an option, confirmed by outcome */
async function pickIn(page: Page, scope: Locator, label: string, option: string, done: () => Promise<void>) {
  await expect(async () => {
    await scope.getByLabel(label).click({ timeout: 2000 });
    await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click({ timeout: 2000 });
    await done();
  }).toPass({ timeout: 15000 });
}

test('经理：新建节奏，在线索详情中加入并停止 / manager: create a cadence, enroll a lead and stop', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '销售节奏');
  await expect(page.getByRole('row', { name: /【演示】新线索 7 天跟进/ })).toContainText('进行中 3');
  await expect(page.getByRole('row', { name: /【演示】方案后跟进/ })).toContainText('第 10 天 · 会议：【演示】商务谈判');

  await page.getByTestId('cadence-new').click();
  const dialog = page.getByRole('dialog', { name: '新建节奏' });
  await dialog.getByLabel('节奏名称').fill('E2E 两步节奏');
  await dialog.getByLabel('跟进主题 1').fill('E2E 首次电话');
  await dialog.getByTestId('cadence-add-step').click();
  await dialog.getByLabel('跟进主题 2').fill('E2E 发资料');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 两步节奏/ });
  await expect(row).toContainText('第 0 天 · 电话：E2E 首次电话');
  await expect(row).toContainText('第 3 天 · 任务：E2E 发资料');
  const cadence = (await api(page, 'GET', '/api/cadences?entity=LEAD')).items.find((c: { name: string }) => c.name === 'E2E 两步节奏');
  let leadId: string | undefined;
  try {
    const lead = await api(page, 'POST', '/api/leads', { name: 'E2E 节奏线索' });
    leadId = lead.id;
    await page.goto(`/leads?id=${lead.id}`);
    const drawer = page.getByRole('dialog', { name: /线索详情/ });
    await expect(drawer).toContainText('E2E 节奏线索');
    await pickIn(page, drawer, '加入销售节奏', 'E2E 两步节奏', () => expect(page.locator('.ant-modal-confirm-title')).toContainText('E2E 两步节奏', { timeout: 1000 }));
    await page.locator('.ant-modal-confirm').getByRole('button', { name: '加入销售节奏' }).click();
    await expect(page.locator('.ant-message')).toContainText('已把 1 条记录加入节奏');
    const panel = drawer.getByTestId('cadence-panel');
    await expect(panel).toContainText('E2E 两步节奏');
    await expect(panel).toContainText('进行中');
    await expect(panel).toContainText('第 1/2 步');
    const acts = await api(page, 'GET', `/api/activities?leadId=${lead.id}`);
    expect(acts.items.map((x: { subject: string }) => x.subject)).toEqual(['E2E 首次电话']);
    // 停止 / stop
    await panel.getByRole('button', { name: /停\s*止/ }).click();
    await page.locator('.ant-popconfirm:visible').getByRole('button', { name: /确\s*定/ }).click();
    await expect(panel).toContainText('已停止');
  } finally {
    if (leadId) await api(page, 'DELETE', `/api/leads/${leadId}`);
    await page.goto('/cadences');
    await api(page, 'DELETE', `/api/cadences/${cadence.id}`);
  }
});
