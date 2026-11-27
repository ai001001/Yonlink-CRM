/**
 * 自定义角色 第三轮：端到端回归（管理员：角色与权限页看到系统角色与演示角色 → 新建基于销售经理、去掉“删除记录”“导出数据”
 * 的角色 → 在用户管理中新建该角色的用户 → 该用户登录后顶部显示自定义角色名，没有回收站入口、客户列表没有删除与导出按钮；
 * 只属于管理员的权限不能勾选）。
 * Custom roles round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { DEMO_ROLES } from '../prisma/demo-data';
import { nav, selectOption, sideMenu } from './helpers';

const SAVE = /保\s*存/;

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('管理员新建自定义角色并分配，用户按角色权限使用 / admin creates and assigns a custom role', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '林管理');
  await nav(page, '角色与权限');
  await expect(page.getByRole('row', { name: new RegExp(DEMO_ROLES[0]!.name) })).toBeVisible();
  await expect(page.getByTestId('system-roles')).toContainText('系统管理员');

  await page.getByTestId('role-new').click();
  const dialog = page.getByRole('dialog', { name: '新建角色' });
  await dialog.getByLabel('角色名称').fill('E2E 受限经理');
  await selectOption(page, dialog, '基础角色', '销售经理');
  const picker = dialog.getByTestId('permission-picker');
  // 按基础角色预填后去掉两项 / prefilled from the base role, then untick two
  await expect(picker.getByRole('checkbox', { name: '删除记录' })).toBeChecked();
  await picker.getByRole('checkbox', { name: '删除记录' }).uncheck();
  await picker.getByRole('checkbox', { name: '导出数据' }).uncheck();
  await expect(picker.getByRole('checkbox', { name: /管理用户与角色/ })).toBeDisabled();
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /E2E 受限经理/ });
  await expect(row).toContainText('销售经理');

  // 新建该角色的用户 / create a user with the role
  await nav(page, '用户管理');
  await page.getByRole('button', { name: '新增用户' }).click();
  const userDialog = page.getByRole('dialog', { name: '新增用户' });
  await userDialog.getByLabel('姓名').fill('E2E 角色用户');
  await userDialog.getByLabel('登录邮箱').fill('e2e.role@demo.yonlink.test');
  await userDialog.getByLabel('初始密码').fill('E2e-Role-Pass-1');
  await selectOption(page, userDialog, '角色', 'E2E 受限经理（基于销售经理）');
  await userDialog.getByRole('button', { name: SAVE }).click();
  const userRow = page.getByRole('row', { name: /E2E 角色用户/ });
  await expect(userRow).toContainText('E2E 受限经理');
  await expect(userRow).toContainText('销售经理');

  // 该用户登录 / the user signs in
  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('邮箱').fill('e2e.role@demo.yonlink.test');
  await page.getByLabel('密码').fill('E2e-Role-Pass-1');
  await page.getByRole('button', { name: /登\s*录/ }).first().click();
  await expect(page.getByTestId('current-role')).toHaveText('E2E 受限经理');
  await expect(sideMenu(page).getByRole('link', { name: '回收站', exact: true })).toHaveCount(0);
  await nav(page, '客户');
  await expect(page.locator('tr.ant-table-row').first()).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /删\s*除/ })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: /导\s*出/ })).toHaveCount(0);
});
