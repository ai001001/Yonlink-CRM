/**
 * 个人设置 第三轮：端到端回归（专用账号：修改名称 → 当前密码错误提示 → 修改密码 → 旧密码不能登录、新密码可以 →
 * 登录记录；演示账号没有修改密码表单）。不修改公共 E2E 管理员账号的密码。
 * Profile round 3: end-to-end regression using a dedicated account (the shared E2E admin password is never changed).
 */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

const EMAIL = `e2e-profile-${Date.now()}@yonlink.test`;
const OLD = 'ProfileOld!2026';
const NEW = 'ProfileNew!2026';

/** 通过界面登录指定账号 / sign in through the UI */
async function signInAs(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();
}

/** 打开个人设置 / open the profile from the user menu */
async function openProfile(page: Page) {
  await page.getByTestId('user-menu').hover();
  await page.getByRole('menuitem', { name: '个人设置' }).click();
  await expect(page).toHaveURL(/\/profile/);
  await expect(page.getByTestId('profile')).toBeVisible();
}

test('修改名称与密码 / rename and change the password', async ({ page }) => {
  // 管理员新建专用账号 / the admin creates a dedicated account
  await signIn(page);
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const created = await page.request.post('/api/admin/users', { headers: { Authorization: `Bearer ${token}` }, data: { name: 'E2E 个人设置', email: EMAIL, role: 'SALES', password: OLD } });
  expect(created.ok()).toBe(true);
  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();

  await signInAs(page, EMAIL, OLD);
  await expect(page.getByTestId('user-menu')).toContainText('E2E 个人设置');
  await openProfile(page);
  await expect(page.getByTestId('profile')).toContainText(EMAIL);

  // 修改名称，右上角同步 / rename; the header follows
  await page.getByRole('button', { name: '修改名称' }).click();
  await page.getByLabel('显示名称').fill('E2E 改名后');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByTestId('profile-name')).toHaveText('E2E 改名后');
  await expect(page.getByTestId('user-menu')).toContainText('E2E 改名后');

  // 当前密码错误 / wrong current password
  await page.getByLabel('当前密码').fill('NotMyPassword!1');
  await page.getByLabel('新密码', { exact: true }).fill(NEW);
  await page.getByLabel('确认新密码').fill(NEW);
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.getByText('当前密码不正确').first()).toBeVisible();

  // 正确修改 / change it
  await page.getByLabel('当前密码').fill(OLD);
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.getByText(/密码已修改/).first()).toBeVisible();
  await expect(page.getByLabel('当前密码')).toHaveValue('');

  // 旧密码不能登录、新密码可以；登录记录显示失败与成功 / old password fails, new works; history shows both
  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await signInAs(page, EMAIL, OLD);
  await expect(page.getByText('邮箱或密码错误').first()).toBeVisible();
  await signInAs(page, EMAIL, NEW);
  await expect(page.getByTestId('user-menu')).toContainText('E2E 改名后');
  await openProfile(page);
  const history = page.getByTestId('profile-history');
  await expect(history).toContainText('登录失败');
  await expect(history).toContainText('密码错误');
  await expect(page.getByTestId('profile-sessions-hint')).toContainText('1 处登录');
});

test('演示账号没有修改密码表单 / demo accounts cannot change the password', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 王芳' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('王芳');
  await openProfile(page);
  await expect(page.getByText('演示账号只能一键免密登录，不能设置密码。')).toBeVisible();
  await expect(page.getByLabel('当前密码')).toHaveCount(0);
});
