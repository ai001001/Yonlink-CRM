/**
 * 自定义模块 第三轮：端到端回归（管理员：模块管理看到演示模块 → 新建模块与字段 → 导航出现该模块 → 新建、查看、编辑
 * 记录 → 删除记录与模块，导航随之消失；销售代表只看到自己负责的演示合同并可新建；客户详情显示关联的模块记录；
 * 只读用户只能查看）。用例结束时删除新建的模块，避免影响共用测试库中的导航用例。
 * Custom modules round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DEMO_MODULES } from '../prisma/demo-data';
import { closeDrawer, nav, sideMenu } from './helpers';

const SAVE = /保\s*存/;
const EDIT = /^编\s*辑$/;
const DELETE = /^删\s*除$/;

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 在弹窗内选择下拉选项并按结果确认 / pick a select option in a dialog, confirmed by outcome */
async function pick(page: Page, scope: Locator, label: string, option: string) {
  const select = scope.getByLabel(label, { exact: true });
  const box = select.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await expect(async () => {
    if (!(await box.textContent())?.includes(option)) {
      await select.click({ timeout: 2000 });
      await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click({ timeout: 2000 });
    }
    await expect(box).toContainText(option, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/** 新建字段 / add a field in the fields drawer */
async function addField(page: Page, drawer: Locator, label: string, type: string, opts: { options?: string[]; required?: boolean } = {}) {
  await drawer.getByTestId('module-field-new').click();
  const dialog = page.getByRole('dialog', { name: '新建字段' });
  await dialog.getByLabel('字段名称').fill(label);
  await pick(page, dialog, '类型', type);
  for (const o of opts.options ?? []) {
    await dialog.getByLabel('选项', { exact: true }).fill(o);
    await dialog.getByLabel('选项', { exact: true }).press('Enter');
  }
  if (opts.required) await dialog.getByLabel('必填').click();
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  await expect(drawer.getByRole('row', { name: new RegExp(label) })).toBeVisible();
}

test('管理员：新建模块与字段，记录的新建、查看、编辑与删除 / admin: module, fields and records', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '林管理');
  await nav(page, '模块管理');
  for (const m of DEMO_MODULES) await expect(page.getByRole('row', { name: new RegExp(m.name) })).toBeVisible();
  await expect(page.getByRole('row', { name: /【演示】合同/ })).toContainText(String(DEMO_MODULES[0]!.records.length));

  // 新建模块 / create a module
  await page.getByTestId('module-new').click();
  const dialog = page.getByRole('dialog', { name: '新建模块' });
  await dialog.getByLabel('模块名称').fill('E2E 项目');
  await dialog.getByLabel('说明').fill('端到端测试模块');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 项目/ });
  await expect(row).toContainText('端到端测试模块');

  // 字段 / fields
  await row.getByRole('button', { name: /^字\s*段$/ }).click();
  const drawer = page.getByRole('dialog', { name: '“E2E 项目”的字段' });
  await addField(page, drawer, '项目编号', '单行文本', { required: true });
  await addField(page, drawer, '项目阶段', '下拉选项', { options: ['立项', '实施'] });
  await addField(page, drawer, '预算', '数字');
  await closeDrawer(page, drawer);
  await expect(row).toContainText('3');

  // 导航出现该模块 / the module appears in the navigation
  await sideMenu(page).getByRole('link', { name: 'E2E 项目', exact: true }).click();
  await expect(page).toHaveURL(/\/modules\/?\?m=/);
  await expect(sideMenu(page).locator('.ant-menu-item-selected')).toHaveText('E2E 项目');
  await expect(page.getByRole('main')).toContainText('端到端测试模块');

  // 新建记录：必填校验、字段取值 / create a record: required check, field values
  await page.getByTestId('record-new').click();
  const form = page.getByRole('dialog', { name: '新建记录' });
  await form.getByLabel('名称').fill('E2E 一期项目');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form.getByText('请填写项目编号')).toBeVisible();
  await form.getByLabel('项目编号').fill('P-001');
  await pick(page, form, '项目阶段', '立项');
  await form.getByLabel('预算').fill('12000.5');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form).toBeHidden();
  const rec = page.getByRole('row', { name: /E2E 一期项目/ });
  await expect(rec).toContainText('P-001');
  await expect(rec).toContainText('立项');
  await expect(rec).toContainText('12000.5');
  await expect(rec).toContainText('林管理');

  // 详情与编辑 / detail and edit
  await rec.getByRole('button', { name: 'E2E 一期项目' }).click();
  const detail = page.getByRole('dialog', { name: '记录详情' });
  await expect(detail.getByTestId('custom-field-values')).toContainText('P-001');
  await detail.getByRole('button', { name: EDIT }).click();
  const edit = page.getByRole('dialog', { name: '编辑记录' });
  await pick(page, edit, '项目阶段', '实施');
  await edit.getByRole('button', { name: SAVE }).click();
  await expect(edit).toBeHidden();
  await expect(detail.getByTestId('custom-field-values')).toContainText('实施');
  await closeDrawer(page, detail);
  await expect(rec).toContainText('实施');

  // 删除记录，再删除模块；导航随之消失 / delete the record, then the module; the menu entry goes away
  await rec.getByRole('button', { name: DELETE }).click();
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(rec).toHaveCount(0);
  await nav(page, '模块管理');
  await row.getByRole('button', { name: DELETE }).click();
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(row).toHaveCount(0);
  await expect(sideMenu(page).getByRole('link', { name: 'E2E 项目', exact: true })).toHaveCount(0);
});

test('销售代表：只看自己负责的演示合同，可新建；客户详情显示关联记录 / sales rep: own records and the account view', async ({ page }) => {
  test.setTimeout(60_000);
  const mine = DEMO_MODULES[0]!.records.filter((r) => r.owner === 'sales1');
  await demoSignIn(page, '王芳');
  await sideMenu(page).getByRole('link', { name: '【演示】合同', exact: true }).click();
  const rows = page.locator('tr.ant-table-row');
  await expect(rows).toHaveCount(mine.length);
  for (const r of mine) await expect(page.getByRole('row', { name: new RegExp(r.name) })).toContainText('王芳');
  await expect(page.getByRole('button', { name: DELETE })).toHaveCount(0);
  await page.getByTestId('record-new').click();
  const form = page.getByRole('dialog', { name: '新建记录' });
  await expect(form).toContainText('销售代表只能将记录指派给自己');
  await form.getByLabel('名称').fill('E2E 王芳的合同');
  await form.getByLabel('合同金额').fill('5000');
  await pick(page, form, '合同类型', '单次采购');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form).toBeHidden();
  await expect(rows).toHaveCount(mine.length + 1);

  // 客户详情：关联的模块记录，点击跳到记录详情 / account view lists linked records and opens them
  const first = mine[0]!;
  await page.getByRole('row', { name: new RegExp(first.name) }).getByRole('link').click();
  const acct = page.getByRole('dialog', { name: /客户详情/ });
  await acct.getByRole('tab', { name: '自定义模块' }).click();
  const panel = acct.getByTestId('account-module-records');
  await expect(panel).toContainText(first.name);
  await expect(panel).toContainText('【演示】设备档案');
  await panel.getByRole('link', { name: first.name }).click();
  await expect(page.getByRole('dialog', { name: '记录详情' })).toContainText(first.name);
});

test('只读用户：只能查看自定义模块记录 / read-only users only view', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await sideMenu(page).getByRole('link', { name: '【演示】设备档案', exact: true }).click();
  await expect(page.locator('tr.ant-table-row')).toHaveCount(DEMO_MODULES[1]!.records.length);
  await expect(page.getByTestId('record-new')).toHaveCount(0);
  await expect(page.getByRole('button', { name: EDIT })).toHaveCount(0);
  await expect(page.getByRole('button', { name: DELETE })).toHaveCount(0);
  await expect(sideMenu(page).getByRole('link', { name: '模块管理' })).toHaveCount(0);
});
