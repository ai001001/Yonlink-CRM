/**
 * 角色权限 第三轮：端到端回归（演示账号一键登录 → 各角色看到的数据与可用操作 → 管理员用户管理）。
 * RBAC round 3: end-to-end regression (one-click demo login, per-role data and actions, admin user management).
 */
import { expect, test, type Page } from '@playwright/test';
import { demoSamples } from '../prisma/demo-data';
import { nav, selectOption } from './helpers';

// 演示数据中的样本（由数据集推导，调整数据后测试自动跟随）/ samples derived from the demo dataset
const S = demoSamples();
const LEADS = '搜索姓名、公司、邮箱、电话';
const ACCOUNTS_SEARCH = '搜索客户名称、电话、网站、地址、联系人';
const DEALS = '搜索商机名称、客户名称';

/** 按名称精确匹配表格行 / Table row matching a name literally */
const rowOf = (page: Page, text: string) => page.getByRole('row', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

/** 在列表页搜索框中搜索（数据较多时列表分页，先搜索再断言）/ search before asserting (lists paginate) */
async function search(page: Page, placeholder: string, text: string): Promise<void> {
  const box = page.getByPlaceholder(placeholder);
  await box.fill(text);
  await box.press('Enter');
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
}

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

  // 经理通过 API 在王芳的客户下新增一个由陈静负责的商机（用于验证商机数按可见范围计数）
  // the manager adds a deal owned by 陈静 under 王芳's account via the API (deal count must follow visibility)
  const demoUsers = (await (await page.request.get('/api/auth/demo-accounts')).json()).items as { id: string; name: string }[];
  const idOf = (name: string) => demoUsers.find((u) => u.name === name)!.id;
  const managerToken = (await (await page.request.post('/api/auth/demo-login', { data: { userId: idOf('郑经理') } })).json()).token;
  const auth = { Authorization: `Bearer ${managerToken}` };
  const accountsRes = await (await page.request.get('/api/accounts?q=' + encodeURIComponent(S.sales1SingleDealAccount), { headers: auth })).json();
  const created = await page.request.post('/api/deals', {
    headers: auth,
    data: { name: 'E2E 陈静负责的商机', accountId: accountsRes.items[0].id, ownerId: idOf('陈静') },
  });
  expect(created.status()).toBe(201);

  // 销售代表：只看自己的数据，无删除、无审计/用户管理，负责人锁定 / sales rep
  await demoLogin(page, '王芳');
  await expect(page.getByTestId('current-role')).toHaveText('销售代表');
  await expect(page.getByText('演示账号').first()).toBeVisible();
  await expect(page.getByRole('menu').getByRole('link', { name: '审计日志' })).toHaveCount(0);
  await expect(page.getByRole('menu').getByRole('link', { name: '用户管理' })).toHaveCount(0);
  await nav(page, '线索');
  await search(page, LEADS, S.sales1Lead);
  await expect(rowOf(page, S.sales1Lead)).toBeVisible();
  const own = rowOf(page, S.sales1Lead);
  await expect(own.getByRole('button', { name: /编\s*辑/ })).toBeVisible();
  await expect(own.getByRole('button', { name: /删\s*除/ })).toHaveCount(0);
  // 他人负责的线索即使按姓名搜索也看不到 / others' leads stay invisible even when searched by name
  await search(page, LEADS, S.sales2Lead);
  await expect(rowOf(page, S.sales2Lead)).toHaveCount(0);
  await search(page, LEADS, S.managerLead);
  await expect(rowOf(page, S.managerLead)).toHaveCount(0);
  await search(page, LEADS, '');
  await page.getByRole('button', { name: '新增线索' }).click();
  const dialog = page.getByRole('dialog', { name: '新增线索' });
  await expect(dialog).toContainText('销售代表只能将记录指派给自己');
  await dialog.getByLabel('姓名').fill('E2E 销售自建线索');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('row', { name: /E2E 销售自建线索/ })).toContainText('王芳');
  // 客户商机数只统计自己负责的（他人负责的 1 个不计入）/ deal count excludes the deal owned by someone else
  await nav(page, '客户');
  await search(page, ACCOUNTS_SEARCH, S.sales1SingleDealAccount);
  const accRow = rowOf(page, S.sales1SingleDealAccount);
  await expect(accRow.getByRole('cell').nth(4)).toHaveText('1');
  await accRow.getByRole('button', { name: S.sales1SingleDealAccount }).click();
  const accDrawer = page.getByRole('dialog', { name: /客户详情/ });
  await expect(accDrawer.getByRole('tab', { name: '商机 (1)' })).toBeVisible();
  await accDrawer.getByRole('tab', { name: '商机 (1)' }).click();
  await expect(accDrawer.getByTestId('account-deals')).not.toContainText('E2E 陈静负责的商机');
  await accDrawer.getByRole('button', { name: '关闭' }).first().click();
  await nav(page, '商机');
  await search(page, DEALS, S.sales1Deal);
  await expect(rowOf(page, S.sales1Deal)).toBeVisible();
  await search(page, DEALS, S.sales2Deal);
  await expect(rowOf(page, S.sales2Deal)).toHaveCount(0);
  await page.goto('/audit-logs');
  await expect(page.getByText('没有权限执行该操作').first()).toBeVisible();
  await signOut(page);

  // 只读用户：能看到全部，不能新建/编辑/删除 / read-only user
  await demoLogin(page, '周会计');
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '线索');
  await expect(page.getByRole('button', { name: '新增线索' })).toHaveCount(0);
  await search(page, LEADS, S.sales2Lead);
  await expect(rowOf(page, S.sales2Lead)).toBeVisible();
  await search(page, LEADS, S.sales1Lead);
  await expect(rowOf(page, S.sales1Lead)).toBeVisible();
  await expect(rowOf(page, S.sales1Lead).getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
  await signOut(page);

  // 销售经理：全部数据 + 删除，无审计与用户管理 / manager
  await demoLogin(page, '郑经理');
  await nav(page, '客户');
  await search(page, ACCOUNTS_SEARCH, S.sales1SingleDealAccount);
  await expect(rowOf(page, S.sales1SingleDealAccount).getByRole('cell').nth(4)).toHaveText('2');
  await nav(page, '线索');
  await search(page, LEADS, 'E2E 销售自建线索');
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
