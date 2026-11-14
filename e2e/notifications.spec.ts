/**
 * 站内通知与提醒 第三轮：端到端回归（经理分配线索 → 销售在铃铛看到通知 → 在线索页点击直接打开详情、未读数减少 →
 * 通知中心全部已读；跟进到期提醒 → 点击跳转跟进详情）。
 * Notifications round 3: end-to-end regression (a manager assigns a lead → the rep sees it in the bell → clicking on
 * the lead page opens the detail and the unread count drops → mark all read in the center; a due reminder opens the
 * activity detail).
 */
import { expect, test, type Page } from '@playwright/test';
import { nav } from './helpers';

/** 演示账号一键登录 / demo one-click sign-in */
async function demoSignIn(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 退出登录 / Sign out */
async function signOut(page: Page): Promise<void> {
  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await expect(page).toHaveURL(/\/login/);
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 铃铛上的未读数 / unread count on the bell */
async function badge(page: Page): Promise<number> {
  const count = await api(page, 'GET', '/api/notifications/unread-count');
  return count.count as number;
}

test('分配通知：铃铛提醒并在当前页打开记录 / assignment notice opens the record', async ({ page }) => {
  await demoSignIn(page, '郑经理');
  const users = await api(page, 'GET', '/api/users');
  const wang = users.items.find((u: { name: string }) => u.name === '王芳');
  await api(page, 'POST', '/api/leads', { name: 'E2E 通知线索', company: 'E2E 通知公司', ownerId: wang.id });

  await signOut(page);
  await demoSignIn(page, '王芳');
  const before = await badge(page);
  expect(before).toBeGreaterThan(0);
  const bell = page.getByTestId('notification-bell');
  await expect(page.locator('.ant-badge').filter({ has: bell })).toContainText(String(before));

  // 已在线索页：点击通知直接打开详情 / already on the lead page: the click opens the detail
  await nav(page, '线索');
  // 等跳转完成再打开铃铛 / open the bell only after the navigation has finished
  await expect(page).toHaveURL(/\/leads/);
  await expect(page.getByText('线索管理')).toBeVisible();
  await bell.click();
  await page.getByTestId('notification-popover').getByRole('link', { name: '郑经理 把线索“E2E 通知线索”分配给了你' }).click();
  const drawer = page.getByRole('dialog', { name: /线索详情/ });
  await expect(drawer).toContainText('E2E 通知公司');
  await expect.poll(() => badge(page)).toBe(before - 1);
  await expect(page.locator('.ant-badge').filter({ has: bell })).toContainText(String(before - 1));
  await drawer.getByRole('button', { name: '关闭' }).first().click();

  // 通知中心：已读的不加粗；全部标为已读 / center: mark all read
  await bell.click();
  await page.getByRole('link', { name: '查看全部通知' }).click();
  await expect(page.getByTestId('notification-unread')).toHaveText(`${before - 1} 条未读`);
  // 跳转后铃铛弹层已收起 / the bell popover closed after navigating
  await expect(page.getByTestId('notification-popover')).toBeHidden();
  await page.getByRole('main').getByRole('button', { name: '全部标为已读' }).click();
  await expect(page.getByTestId('notification-unread')).toHaveText('0 条未读');
  await expect(page.locator('.ant-badge').filter({ has: bell }).locator('.ant-badge-count')).toHaveCount(0);
});

test('跟进到期提醒：跳转到跟进详情 / due reminder opens the activity', async ({ page }) => {
  await demoSignIn(page, '陈静');
  const dueAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await api(page, 'POST', '/api/activities', { type: 'CALL', subject: 'E2E 到期提醒', dueAt });

  await page.goto('/notifications');
  await page.getByText('未读', { exact: true }).click();
  const link = page.getByRole('link', { name: /跟进“E2E 到期提醒”将于 .* 到期/ });
  await expect(link).toBeVisible();
  await expect(page.getByRole('row').filter({ has: link })).toContainText('跟进提醒');
  await link.click();
  await expect(page).toHaveURL(/\/activities\?id=/);
  await expect(page.getByRole('dialog', { name: 'E2E 到期提醒' })).toBeVisible();
});
