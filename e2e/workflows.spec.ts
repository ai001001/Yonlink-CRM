/**
 * 工作流规则 第三轮：端到端回归（经理：工作流规则页看到 4 条演示规则 → 新建“线索状态变为已确认时通知负责人并创建任务” →
 * 改线索状态后收到工作流提醒、出现任务 → 在列表中停用规则，再改状态不再执行；只读用户只能查看）。基于演示数据。
 * Workflow rules round 3: end-to-end regression on the demo data.
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

test('经理：新建工作流规则、触发执行、停用 / manager: create, fire and disable a workflow', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '工作流规则');
  await expect(page.getByRole('row', { name: /高分新线索/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /进入商务谈判/ })).toContainText('阶段变化时');
  // 演示规则：线索与商机 6 条（含定时工作流的 2 条），加上客户与工单各 1 条（#60c）；只数演示规则，其他用例新建的规则不影响
  // demo rules: 6 for leads and deals (2 scheduled) plus one each for accounts and tickets (#60c); only demo rules are counted
  await expect(page.locator('tr.ant-table-row').filter({ hasText: '【演示】' })).toHaveCount(8);

  // 新建规则 / create a rule
  await page.getByRole('button', { name: '新建工作流规则' }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作流规则' });
  await dialog.getByLabel('规则名称').fill('E2E 线索已确认');
  await pick(page, dialog, '触发时机', '指定字段变化时');
  await pick(page, dialog, '变化的字段', '线索状态');
  await dialog.getByTestId('workflow-add-condition').click();
  await pick(page, dialog, '字段 1', '线索状态');
  await pick(page, dialog, '值 1', '已确认');
  await dialog.getByLabel('提醒内容 1', { exact: true }).fill('E2E 线索已确认');
  await dialog.getByTestId('workflow-add-action').click();
  await pick(page, dialog, '动作类型 2', '创建任务');
  await dialog.getByLabel('任务主题 2', { exact: true }).fill('E2E 发送产品资料');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 线索已确认/ });
  await expect(row).toContainText('线索状态变化时');
  await expect(row).toContainText('线索状态 等于 已确认');
  await expect(row).toContainText('通知记录负责人：E2E 线索已确认');
  await expect(row).toContainText('创建任务“E2E 发送产品资料”，1 天后到期，分配给记录负责人');

  // 触发：改线索状态 / fire: change a lead's status
  const lead = await api(page, 'POST', '/api/leads', { name: 'E2E 工作流线索' });
  await api(page, 'PATCH', `/api/leads/${lead.id}`, { status: 'QUALIFIED' });
  const notes = await api(page, 'GET', '/api/notifications?pageSize=50');
  expect(notes.items.some((n: { type: string; title: string }) => n.type === 'WORKFLOW' && n.title === 'E2E 线索已确认 · E2E 工作流线索')).toBe(true);
  await page.goto(`/leads?id=${lead.id}`);
  const drawer = page.getByRole('dialog', { name: /线索详情/ });
  await expect(drawer.getByText('E2E 发送产品资料')).toBeVisible();

  // 执行次数 1；停用后不再执行（线索详情抽屉会遮住侧栏，直接访问地址）/ run count 1; disabled rules stop (the drawer covers the menu)
  await page.goto('/workflows');
  await expect(row).toBeVisible();
  await expect(row.locator('td').nth(6)).toHaveText('1');
  await row.getByRole('switch').click();
  await expect.poll(async () => (await api(page, 'GET', '/api/workflows?entity=LEAD')).items.find((r: { name: string }) => r.name === 'E2E 线索已确认').isActive).toBe(false);
  await api(page, 'PATCH', `/api/leads/${lead.id}`, { status: 'CONTACTED' });
  await api(page, 'PATCH', `/api/leads/${lead.id}`, { status: 'QUALIFIED' });
  const rules = await api(page, 'GET', '/api/workflows?entity=LEAD');
  expect(rules.items.find((r: { name: string }) => r.name === 'E2E 线索已确认').runCount).toBe(1);
});

test('只读用户：工作流规则页只能查看 / read-only users can only view', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await page.goto('/workflows');
  await expect(page.locator('tr.ant-table-row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '新建工作流规则' })).toHaveCount(0);
  await expect(page.locator('tr.ant-table-row').first().getByRole('switch')).toBeDisabled();
  await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(0);
});
