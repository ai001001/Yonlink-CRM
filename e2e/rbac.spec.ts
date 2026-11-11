/**
 * 角色权限 第三轮：端到端回归（演示账号一键登录 → 各角色看到的数据与可用操作 → 管理员用户管理）。
 * RBAC round 3: end-to-end regression (one-click demo login, per-role data and actions, admin user management).
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, selectOption } from './helpers';

/** 在登录页以演示账号一键登录 / One-click demo login on the sign-in page */
async function demoLogin(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  const list = page.getByTestId('demo-accounts');
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 退出登录 / Sign out */
async function signOut(page: Page): Promise<void> {
  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await expect(page).toHaveURL(/\/login/);
}

test('演示账号列表与各角色权限 / demo accounts and per-role permissions', async ({ page }) => {
  // 登录页列出 5 个演示账号，不显示密码 / five demo accounts, no passwords
  await page.goto('/login');
  const list = page.getByTestId('demo-accounts');
  await expect(list.getByRole('row')).toHaveCount(6);
  for (const role of ['系统管理员', '销售经理', '销售代表', '只读用户']) await expect(list).toContainText(role);
  await expect(list).toContainText('sales1@demo.yonlink.test');

  // 销售代表：只看自己的数据，无删除、无审计/用户管理，负责人锁定 / sales rep
  await demoLogin(page, '王芳');
  await expect(page.getByTestId('current-role')).toHaveText('销售代表');
  await expect(page.getByText('演示账号').first()).toBeVisible();
  await expect(page.getByRole('menu').getByRole('link', { name: '审计日志' })).toHaveCount(0);
  await expect(page.getByRole('menu').getByRole('link', { name: '用户管理' })).toHaveCount(0);
  await nav(page, '线索');
  await expect(page.getByRole('row', { name: /【演示】张先生/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /【演示】李女士/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /【演示】赵先生/ })).toHaveCount(0);
  const own = page.getByRole('row', { name: /【演示】张先生/ });
  await expect(own.getByRole('button', { name: /编\s*辑/ })).toBeVisible();
  await expect(own.getByRole('button', { name: /删\s*除/ })).toHaveCount(0);
  await page.getByRole('button', { name: '新增线索' }).click();
  const dialog = page.getByRole('dialog', { name: '新增线索' });
  await expect(dialog).toContainText('销售代表只能将记录指派给自己');
  await dialog.getByLabel('姓名').fill('E2E 销售自建线索');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('row', { name: /E2E 销售自建线索/ })).toContainText('王芳');
  await nav(page, '商机');
  await expect(page.getByRole('row', { name: /【演示】远望年度采购/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /【演示】锦城仓储系统/ })).toHaveCount(0);
  await page.goto('/audit-logs');
  await expect(page.getByText('没有权限执行该操作').first()).toBeVisible();
  await signOut(page);

  // 只读用户：能看到全部，不能新建/编辑/删除 / read-only user
  await demoLogin(page, '周会计');
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '线索');
  await expect(page.getByRole('row', { name: /【演示】李女士/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /【演示】张先生/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增线索' })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /【演示】张先生/ }).getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
  await signOut(page);

  // 销售经理：全部数据 + 删除，无审计与用户管理 / manager
  await demoLogin(page, '郑经理');
  await nav(page, '线索');
  await expect(page.getByRole('row', { name: /E2E 销售自建线索/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 销售自建线索/ }).getByRole('button', { name: /删\s*除/ })).toBeVisible();
  await expect(page.getByRole('menu').getByRole('link', { name: '用户管理' })).toHaveCount(0);
  await signOut(page);
});

test('系统管理员管理用户 / admin manages users', async ({ page }) => {
  await demoLogin(page, '林管理');
  await expect(page.getByTestId('current-role')).toHaveText('系统管理员');
  await nav(page, '用户管理');
  await expect(page.getByText('角色权限说明')).toBeVisible();
  const me = page.getByRole('row', { name: /林管理/ });
  await expect(me).toContainText('（我）');
  await expect(me.getByRole('button', { name: /停\s*用/ })).toHaveCount(0);

  // 新增用户 / create
  await page.getByRole('button', { name: '新增用户' }).click();
  let dialog = page.getByRole('dialog', { name: '新增用户' });
  await dialog.getByLabel('姓名').fill('E2E 新销售');
  await dialog.getByLabel('登录邮箱').fill('e2e.newsales@demo.yonlink.test');
  await dialog.getByLabel('初始密码').fill('E2e-Initial-Pass-1');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  const row = page.getByRole('row', { name: /E2E 新销售/ });
  await expect(row).toContainText('销售代表');
  await expect(row).toContainText('启用');

  // 改为销售经理 / promote to manager
  await row.getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑用户' });
  await selectOption(page, dialog, '角色', '销售经理');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(row).toContainText('销售经理');

  // 停用 / deactivate
  await row.getByRole('button', { name: /停\s*用/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(row).toContainText('已停用');

  // 审计日志记录了用户管理操作 / audit log records it
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table')).toContainText('用户');
});
