/**
 * 服务工单 第三轮：端到端回归（新建客户 → 新建紧急工单 → 开始处理 → 解决（需填写解决方案）→ 关闭 → 按状态查看；
 * 只读用户查看演示工单但不能新建或处理）。
 * Service tickets round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { closeDrawer, nav, pickRecord, searchList, selectOption, signIn } from './helpers';

const SAVE = /保\s*存/;

test('工单从新建到关闭 / ticket lifecycle', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  await nav(page, '客户');
  await page.getByRole('button', { name: '新增客户' }).click();
  let dialog = page.getByRole('dialog', { name: '新增客户' });
  await dialog.getByLabel('客户名称').fill('E2E 工单客户');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  // 客户联系人 / a contact of the account
  await page.getByRole('button', { name: 'E2E 工单客户' }).click();
  const accDrawer = page.getByRole('dialog', { name: /客户详情/ });
  await accDrawer.getByRole('tab', { name: /联系人/ }).click();
  await accDrawer.getByRole('button', { name: '新增联系人' }).click();
  dialog = page.getByRole('dialog', { name: '新增联系人' });
  await dialog.getByLabel('姓名').fill('E2E 王工');
  await dialog.getByLabel('电话').fill('13900001111');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(accDrawer.getByTestId('contacts-panel')).toContainText('E2E 王工');
  await closeDrawer(page, accDrawer);

  await nav(page, '服务工单');
  await page.getByRole('button', { name: '新建工单' }).click();
  dialog = page.getByRole('dialog', { name: '新建工单' });
  await dialog.getByLabel('主题').fill('E2E 增压器漏油');
  await pickRecord(page, dialog, '客户', '工单客户', 'E2E 工单客户');
  // 选客户后加载其联系人 / the account's contacts load after picking it
  await selectOption(page, dialog, '联系人', 'E2E 王工');
  await selectOption(page, dialog, '优先级', '紧急');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 增压器漏油/ });
  await expect(row).toContainText('紧急');
  await expect(row).toContainText('新建');
  await expect(row).toContainText(/CS-\d{4}-\d{4}/);

  // 处理 / work the ticket
  await row.getByRole('button', { name: 'E2E 增压器漏油' }).click();
  const drawer = page.getByRole('dialog', { name: /工单详情 · CS-/ });
  const actions = drawer.getByTestId('ticket-actions');
  await expect(drawer.getByTestId('ticket-detail')).toContainText('E2E 王工 · 13900001111');
  await actions.getByRole('button', { name: '开始处理' }).click();
  await expect(drawer.getByTestId('ticket-detail')).toContainText('处理中');
  await actions.getByRole('button', { name: /解\s*决/ }).click();
  const modal = page.getByRole('dialog', { name: '解决' });
  await expect(modal.getByRole('button', { name: SAVE })).toBeDisabled();
  await modal.getByLabel('解决方案').fill('更换涡轮端密封圈，试车正常');
  await modal.getByRole('button', { name: SAVE }).click();
  await expect(modal).toBeHidden();
  await expect(drawer.getByTestId('ticket-resolution')).toHaveText('更换涡轮端密封圈，试车正常');
  await expect(drawer.getByTestId('ticket-detail')).toContainText('已解决');
  await actions.getByRole('button', { name: /关\s*闭/ }).click();
  await expect(drawer.getByTestId('ticket-detail')).toContainText('已关闭');
  await expect(actions.getByRole('button', { name: '重新打开' })).toBeVisible();
  // 抽屉右上角的关闭按钮（“关闭工单”按钮文字带空格，不会被选中）/ the drawer's own close button
  await closeDrawer(page, drawer);

  // 默认只看未解决；按“已关闭”查看 / unresolved by default; view closed
  await expect(row).toHaveCount(0);
  await page.getByText(/^已关闭 \(\d+\)$/).click();
  await expect(row).toContainText('已关闭');
});

test('只读用户只能查看工单 / read-only users only view', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('周会计');
  await nav(page, '服务工单');
  await expect(page.getByRole('button', { name: '新建工单' })).toHaveCount(0);
  await searchList(page, '搜索工单号、主题、客户、联系人', '异响');
  const row = page.getByRole('row', { name: /涡轮增压器异响/ });
  await expect(row).toContainText('处理中');
  await row.getByRole('button', { name: /涡轮增压器异响/ }).click();
  const drawer = page.getByRole('dialog', { name: /工单详情/ });
  await expect(drawer.getByTestId('ticket-detail')).toContainText('【演示】');
  await expect(drawer.getByTestId('ticket-actions')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
});
