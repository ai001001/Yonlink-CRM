/**
 * 商机竞争对手与联系人角色 第三轮：端到端回归（新建客户与联系人 → 新建商机 → 添加联系人角色、切换主要联系人、
 * 修改角色、移除 → 新增竞争对手、同名提示、修改威胁程度 → 操作记录 → 报表竞争对手胜负；只读用户只能查看）。
 * Deal competitors and contact roles round 3: end-to-end regression.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeDrawer, nav, pickRecord, searchList, selectOption, signIn } from './helpers';

const SAVE = /保\s*存/;

/**
 * 按精确标签在下拉中选择，按结果重试（“联系人”标签与“主要联系人”复选框同名包含，需精确匹配）。
 * Pick an option by exact label, retrying by outcome (“联系人” is contained in the “主要联系人” checkbox label).
 */
async function pickExact(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  const dropdown = page.locator('.ant-select-dropdown:visible');
  const item = dropdown.getByTitle(option, { exact: true });
  await expect(async () => {
    if (await scope.getByTitle(option, { exact: true }).isVisible()) return;
    if (!(await item.isVisible())) await scope.getByLabel(label, { exact: true }).click({ timeout: 2000 });
    await item.click({ timeout: 2000 });
    await expect(scope.getByTitle(option, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
}

/**
 * 切换抽屉页签，按结果重试（抽屉打开动画期间的点击可能被忽略）。
 * Switch a drawer tab, retrying by outcome (clicks during the drawer's opening animation can be ignored).
 */
async function openTab(drawer: Locator, tab: string, testId: string): Promise<Locator> {
  const panel = drawer.getByTestId(testId);
  await expect(async () => {
    if (!(await panel.isVisible())) await drawer.getByRole('tab', { name: tab, exact: true }).click({ timeout: 2000 });
    await expect(panel).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  return panel;
}

test('联系人角色与竞争对手完整流程 / contact roles and competitors flow', async ({ page }) => {
  // 步骤较多（客户、联系人、商机、角色、对手、报表）/ many steps
  test.setTimeout(90_000);
  await signIn(page);

  // 客户与两位联系人 / an account with two contacts
  await nav(page, '客户');
  await page.getByRole('button', { name: '新增客户' }).click();
  let dialog = page.getByRole('dialog', { name: '新增客户' });
  await dialog.getByLabel('客户名称').fill('E2E 角色客户');
  await dialog.getByRole('button', { name: SAVE }).click();
  await page.getByRole('button', { name: 'E2E 角色客户' }).click();
  const accDrawer = page.getByRole('dialog', { name: /客户详情/ });
  await accDrawer.getByRole('tab', { name: /联系人/ }).click();
  for (const [name, title] of [
    ['欧阳总', '总经理'],
    ['钱工', ''],
  ]) {
    await accDrawer.getByRole('button', { name: '新增联系人' }).click();
    dialog = page.getByRole('dialog', { name: '新增联系人' });
    await dialog.getByLabel('姓名').fill(name!);
    if (title) await dialog.getByLabel('职位').fill(title);
    await dialog.getByRole('button', { name: SAVE }).click();
    await expect(accDrawer.getByTestId('contacts-panel').getByRole('row', { name: new RegExp(name!) })).toBeVisible();
  }
  await closeDrawer(page, accDrawer);

  // 商机 / a deal
  await nav(page, '商机');
  await page.getByRole('button', { name: '新增商机' }).click();
  dialog = page.getByRole('dialog', { name: '新增商机' });
  await dialog.getByLabel('商机名称').fill('E2E 角色商机');
  await pickRecord(page, dialog, '关联客户', '角色客户', 'E2E 角色客户');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'E2E 角色商机' }).click();
  const drawer = page.getByRole('dialog', { name: /商机详情 · E2E 角色商机/ });
  // 页签全部一行显示，不折叠到“…”菜单 / every tab fits on one line, none collapsed into the “…” menu
  await expect(drawer.locator('.ant-tabs-nav-operations-hidden')).toHaveCount(1);

  // 联系人角色 / contact roles
  const panel = await openTab(drawer, '联系人角色', 'deal-contact-roles');
  const form = panel.locator('form');
  await pickExact(page, form, '联系人', '欧阳总（总经理）');
  await form.getByLabel('主要联系人').check();
  await form.getByRole('button', { name: '添加角色' }).click();
  const ouyang = panel.getByRole('row', { name: /欧阳总/ });
  await expect(ouyang).toContainText('主要联系人');
  await expect(ouyang).toContainText('决策人');
  await pickExact(page, form, '联系人', '钱工');
  await selectOption(page, form, '角色', '评估人');
  await form.getByRole('button', { name: '添加角色' }).click();
  const qian = panel.getByRole('row', { name: /钱工/ });
  await expect(qian).toContainText('评估人');
  // 所有联系人都有角色后不再显示添加表单 / the add form hides once every contact has a role
  await expect(form).toHaveCount(0);
  await qian.getByRole('button', { name: '设为主要' }).click();
  await expect(qian).toContainText('主要联系人');
  await expect(ouyang).not.toContainText('主要联系人');
  await selectOption(page, ouyang, '角色 欧阳总', '影响者');
  await expect(ouyang).toContainText('影响者');
  await ouyang.getByRole('button', { name: '移除 欧阳总' }).click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(ouyang).toHaveCount(0);
  await expect(form).toBeVisible();

  // 竞争对手 / competitors
  const comps = await openTab(drawer, '竞争对手', 'deal-competitors');
  await comps.getByRole('button', { name: '新增竞争对手' }).click();
  let modal = page.getByRole('dialog', { name: '新增竞争对手' });
  await modal.getByLabel('竞争对手').fill('E2E 对手公司');
  await selectOption(page, modal, '威胁程度', '高');
  await modal.getByLabel('优势').fill('报价低 10%');
  await modal.getByRole('button', { name: SAVE }).click();
  await expect(modal).toBeHidden();
  const row = comps.getByRole('row', { name: /E2E 对手公司/ });
  await expect(row).toContainText('高');
  await expect(row).toContainText('报价低 10%');
  // 同名（不区分大小写）提示 / duplicate name (case-insensitive)
  await comps.getByRole('button', { name: '新增竞争对手' }).click();
  await modal.getByLabel('竞争对手').fill('e2e 对手公司');
  await modal.getByRole('button', { name: SAVE }).click();
  await expect(modal.getByText('该商机已有同名竞争对手')).toBeVisible();
  await modal.getByRole('button', { name: /取\s*消/ }).click();
  await expect(modal).toBeHidden();
  await row.getByRole('button', { name: '编辑 E2E 对手公司' }).click();
  modal = page.getByRole('dialog', { name: '编辑竞争对手' });
  await selectOption(page, modal, '威胁程度', '低');
  await modal.getByRole('button', { name: SAVE }).click();
  await expect(modal).toBeHidden();
  await expect(row).toContainText('低');

  // 操作记录 / audit trail
  const trail = await openTab(drawer, '操作记录', 'audit-trail');
  await expect(trail).toContainText('商机 · 修改竞争对手');
  await expect(trail).toContainText('竞争对手：E2E 对手公司');
  await expect(trail).toContainText('联系人：欧阳总 · 影响者');
  await closeDrawer(page, drawer);

  // 报表竞争对手胜负 / report
  await nav(page, '报表');
  await expect(page.getByTestId('table-competitors').getByRole('row', { name: /E2E 对手公司/ })).toBeVisible();
});

test('只读用户只能查看联系人角色与竞争对手 / read-only users only view', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('周会计');
  await nav(page, '商机');
  // 只看演示商机（每个都有联系人角色）/ demo deals only (each has contact roles)
  await searchList(page, '搜索商机名称、客户名称', '【演示】');
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toContainText('【演示】');
  await page.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('button').first().click();
  const drawer = page.getByRole('dialog', { name: /商机详情/ });
  const panel = await openTab(drawer, '联系人角色', 'deal-contact-roles');
  await expect(panel).toContainText('决策人');
  await expect(panel.getByRole('button', { name: '添加角色' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /移除/ })).toHaveCount(0);
  await openTab(drawer, '竞争对手', 'deal-competitors');
  await expect(drawer.getByRole('button', { name: '新增竞争对手' })).toHaveCount(0);
});
