/**
 * 标准字段可配置 第三轮：端到端回归（在 E2E 测试组织中操作，不影响演示数据）：管理员在“下拉选项”页给线索来源改名、
 * 新增并上移自定义选项、停用一个来源 → 新增线索表单按新顺序列出、不含停用项，列表与筛选显示新名称；商机阶段改名、
 * 停用并修改赢单概率 → 商机表单不含停用阶段、筛选仍可选、销售预测说明显示新概率；审计日志记录修改；非管理员看不到入口。
 * Configurable picklists round 3: end-to-end regression in the E2E organization (demo data untouched).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { nav, sideMenu, signIn } from './helpers';

const SAVE = /保\s*存/;

/** 打开下拉框并读取选项 / open a select and read its options */
async function optionsOf(page: Page, select: Locator): Promise<string[]> {
  await select.click();
  const dropdown = page.locator('.ant-select-dropdown:visible');
  await expect(dropdown).toBeVisible();
  const items = await dropdown.locator('.ant-select-item-option').allInnerTexts();
  await page.keyboard.press('Escape');
  return items.map((x) => x.trim());
}

test('管理员：线索来源与商机阶段的配置在各页面生效 / admin: pick lists apply across pages', async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);
  await nav(page, '下拉选项');
  const table = page.getByTestId('picklist-table');
  // 线索来源：改名、新增并上移到第一位、停用“电话开发” / lead source: rename, add and move to the top, deactivate
  await table.getByLabel('显示名称 官网').fill('公司官网');
  await page.getByTestId('picklist-add').click();
  await table.getByLabel('显示名称 新选项名称').fill('E2E 直播间');
  for (let i = 0; i < 7; i++) await table.getByRole('button', { name: '上移 E2E 直播间' }).click();
  await table.getByRole('switch', { name: '启用 电话开发' }).click();
  await page.getByTestId('picklists-save').click();
  await expect(page.getByText('已保存，所有页面已按新选项显示')).toBeVisible();
  // 保存后页面按新配置重新显示 / the page re-renders with the new setup
  await expect(table.locator('tr.ant-table-row').first()).toContainText('自定义');
  await expect(table.getByLabel('显示名称 官网')).toHaveValue('公司官网');

  // 新增线索：表单按新顺序列出启用的来源 / the lead form lists active sources in the new order
  await nav(page, '线索');
  await page.getByRole('button', { name: '新增线索' }).click();
  const form = page.getByRole('dialog', { name: '新增线索' });
  const sources = await optionsOf(page, form.getByLabel('线索来源'));
  expect(sources[0]).toBe('E2E 直播间');
  expect(sources).toContain('公司官网');
  expect(sources).not.toContain('电话开发');
  expect(sources).not.toContain('官网');
  await form.getByLabel('姓名').fill('E2E 直播线索');
  await form.getByLabel('线索来源').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('E2E 直播间', { exact: true }).click();
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('row', { name: /E2E 直播线索/ })).toContainText('E2E 直播间');
  // 筛选列出全部来源（含已停用的）/ the filter lists every source, inactive included
  const filter = await optionsOf(page, page.getByRole('main').getByLabel('线索来源', { exact: true }));
  expect(filter).toContain('电话开发');

  // 商机阶段：改名、停用“需求分析”、方案报价概率改为 55 / deal stage: rename, deactivate, probability
  await nav(page, '下拉选项');
  await page.getByText('商机阶段', { exact: true }).click();
  await table.getByLabel('显示名称 方案报价').fill('已出方案');
  await table.getByRole('switch', { name: '启用 需求分析' }).click();
  await table.getByLabel('赢单概率（%） 方案报价').fill('55');
  await expect(table.getByText('不能停用')).toHaveCount(2);
  await page.getByTestId('picklists-save').click();
  await expect(page.getByText('已保存，所有页面已按新选项显示')).toBeVisible();

  await nav(page, '商机');
  await page.getByRole('button', { name: '新增商机' }).click();
  const dealForm = page.getByRole('dialog', { name: '新增商机' });
  const stages = await optionsOf(page, dealForm.getByLabel('销售阶段'));
  expect(stages).toContain('已出方案');
  expect(stages).not.toContain('需求分析');
  await dealForm.getByRole('button', { name: /取\s*消/ }).click();
  expect(await optionsOf(page, page.getByRole('main').getByLabel('销售阶段', { exact: true }))).toContain('需求分析');
  await nav(page, '销售预测');
  await expect(page.getByRole('main')).toContainText('55');

  // 审计 / audit
  await nav(page, '审计日志');
  await expect(page.getByRole('main')).toContainText('下拉选项：商机阶段');

  // 恢复默认（共用测试库，后续用例按默认选项运行）；使用中的自定义来源只能停用
  // restore the defaults (shared test DB; later specs expect them); the custom source is in use, so it is deactivated
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const headers = { Authorization: `Bearer ${token}` };
  const fields = (await (await page.request.get('/api/picklists', { headers })).json()).fields as Record<string, { value: string; isCustom: boolean; probability: number | null }[]>;
  const reset = (field: string) =>
    fields[field]!.map((o) => ({ value: o.value, label: null, isActive: !o.isCustom, ...(o.probability !== null ? { probability: null } : {}) }));
  for (const field of ['LEAD_SOURCE', 'DEAL_STAGE']) {
    const res = await page.request.put(`/api/picklists/${field}`, { headers, data: { values: reset(field) } });
    expect(res.ok(), field).toBe(true);
  }
  const after = (await (await page.request.get('/api/picklists', { headers })).json()).fields;
  expect(after.DEAL_STAGE.map((o: { probability: number | null }) => o.probability)).toEqual([10, 20, 40, 70, null, null]);
  expect(after.LEAD_SOURCE.filter((o: { isActive: boolean }) => !o.isActive)).toHaveLength(1);
});

test('非管理员看不到下拉选项设置 / non-admins have no pick-list setup', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 郑经理' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('郑经理');
  await expect(sideMenu(page).getByRole('link', { name: '下拉选项' })).toHaveCount(0);
});
