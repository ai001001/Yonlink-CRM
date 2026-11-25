/**
 * 移动端 第一轮：功能测试（手机尺寸 390×844、触屏）：登录页不超宽且演示账号可用；顶部栏、抽屉菜单（组织、角色、语言、
 * 完整导航）、底部常用入口（跳转与高亮、“更多”打开菜单）；客户详情抽屉不超出屏幕、电话可点拨；手机上新建跟进；
 * 头像菜单进入个人设置与退出；可安装网页应用（清单、图标、主题色）；桌面宽度下仍是侧栏布局。
 * Mobile round 1: functional tests on a 390×844 touch viewport.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
  await expect(page.getByTestId('user-menu')).toHaveAttribute('aria-label', name);
}

/** 页面没有横向超宽 / no horizontal overflow */
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test('登录页与外壳：顶部栏、抽屉菜单、语言切换 / login page and shell', async ({ page }) => {
  await page.goto('/login');
  const demo = page.getByTestId('demo-accounts');
  await expect(demo).toBeVisible();
  await fits(page);
  // 手机上不显示邮箱列 / no email column on phones
  await expect(demo).not.toContainText('sales1@demo.yonlink.test');
  await demoSignIn(page, '王芳');
  await fits(page);
  await expect(page.getByTestId('sider')).toHaveCount(0);
  await expect(page.getByTestId('mobile-menu-toggle')).toBeVisible();
  await expect(page.getByTestId('notification-bell')).toBeVisible();
  // 抽屉菜单：组织、角色、语言、完整导航 / drawer menu: organization, role, language, full navigation
  await page.getByTestId('mobile-menu-toggle').click();
  const menu = page.getByTestId('mobile-menu');
  await expect(menu).toContainText('演示涡轮增压器有限公司');
  await expect(menu.getByTestId('current-role')).toHaveText('销售代表');
  for (const name of ['线索', '服务工单', '报表', '【演示】合同']) await expect(menu.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: '用户管理', exact: true })).toHaveCount(0);
  // 等打开动画结束再量（允许亚像素误差）/ measure after the opening animation (sub-pixel tolerance)
  await expect.poll(async () => (await menu.locator('xpath=ancestor-or-self::*[contains(@class,"ant-drawer-content-wrapper")][1]').boundingBox())!.width).toBeLessThanOrEqual(390.5);
  // 语言切换 / switch language
  await menu.getByText('English', { exact: true }).click();
  await expect(page.getByTestId('mobile-tabbar')).toContainText('Accounts');
  // 切换语言会重新渲染页面，抽屉随之关闭；重新打开再切回中文 / switching re-renders the page and closes the drawer; reopen to switch back
  if (!(await menu.isVisible())) await page.getByTestId('mobile-menu-toggle').click();
  await menu.getByText('中文', { exact: true }).click();
  await expect(page.getByTestId('mobile-tabbar')).toContainText('客户');
  if (!(await menu.isVisible())) await page.getByTestId('mobile-menu-toggle').click();
  // 点菜单项跳转并关闭抽屉 / an entry navigates and closes the drawer
  await menu.getByRole('link', { name: '线索', exact: true }).click();
  await expect(page).toHaveURL(/\/leads\/?$/);
  await expect(menu).toBeHidden();
  await expect(page.getByRole('main').locator('.ant-card').first()).toBeVisible();
  await fits(page);
});

test('底部常用入口：跳转、高亮与“更多” / tab bar', async ({ page }) => {
  await demoSignIn(page, '王芳');
  const bar = page.getByTestId('mobile-tabbar');
  for (const [label, path] of [['客户', '/accounts'], ['商机', '/deals'], ['跟进', '/activities'], ['工作台', '/']] as const) {
    await bar.getByRole('link', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '' : path}/?$`));
    await expect(bar.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('main').locator('.ant-card').first()).toBeVisible();
    await fits(page);
  }
  // 底部栏不遮挡页面内容：内容底部留白不小于栏高 / content leaves room for the bar
  const barBox = (await bar.boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(844 + 1);
  const pad = await page.getByRole('main').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(pad).toBeGreaterThanOrEqual(barBox.height);
  await bar.getByTestId('mobile-more').click();
  await expect(page.getByTestId('mobile-menu')).toBeVisible();
});

test('客户详情、电话可点拨、手机上新建跟进 / details, tap to call, create on a phone', async ({ page }) => {
  test.setTimeout(60_000);
  await demoSignIn(page, '王芳');
  await page.getByTestId('mobile-tabbar').getByRole('link', { name: '客户' }).click();
  const row = page.locator('tr.ant-table-row').first();
  const phone = row.getByTestId('phone-link');
  await expect(phone).toHaveAttribute('href', /^tel:\+?[\d\-()]+$/);
  await row.getByRole('button').first().click();
  const drawer = page.getByRole('dialog', { name: /客户详情/ });
  await expect(drawer).toBeVisible();
  // 等打开动画结束再量（允许亚像素误差）/ measure after the opening animation (sub-pixel tolerance)
  await expect.poll(async () => (await drawer.locator('xpath=ancestor-or-self::*[contains(@class,"ant-drawer-content-wrapper")][1]').boundingBox())!.width).toBeLessThanOrEqual(390.5);
  await expect(drawer.getByTestId('phone-link').first()).toHaveAttribute('href', /^tel:/);
  await fits(page);

  // 新建跟进 / create an activity
  await page.goto('/activities');
  await page.getByRole('button', { name: '新增跟进' }).click();
  const form = page.getByRole('dialog', { name: '新增跟进' });
  await expect.poll(async () => {
    const b = (await form.boundingBox())!;
    return b.x >= 0 && b.x + b.width <= 390.5;
  }).toBe(true);
  await form.getByLabel('主题').fill('E2E 手机上记录的电话');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('row', { name: /E2E 手机上记录的电话/ })).toBeVisible();
});

test('头像菜单：个人设置与退出 / avatar menu: profile and sign out', async ({ page }) => {
  await demoSignIn(page, '周会计');
  // 按结果重试：弹出层打开动画期间的点击可能落空（与导航用例相同）/ retry by outcome: taps during the pop-up animation can miss (as in the navigation spec)
  const choose = async (item: string, url: RegExp) => {
    await expect(async () => {
      if (!url.test(page.url())) {
        if (!(await page.getByRole('menuitem', { name: item }).isVisible())) await page.getByTestId('user-menu').click({ timeout: 2000 });
        await page.getByRole('menuitem', { name: item }).click({ timeout: 2000 });
      }
      await expect(page).toHaveURL(url, { timeout: 3000 });
    }).toPass({ timeout: 20000 });
  };
  await choose('个人设置', /\/profile\/?$/);
  // 选择后菜单关闭 / the menu closes after a choice
  await expect(page.getByRole('menuitem', { name: '个人设置' })).toBeHidden();
  await fits(page);
  await choose('退出登录', /\/login\/?$/);
});

test('可安装网页应用：清单、图标、主题色 / installable web app', async ({ page }) => {
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1f5fbf');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  const res = await page.request.get(href!);
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toMatchObject({ short_name: '永联CRM', start_url: './', scope: './', display: 'standalone', theme_color: '#1f5fbf' });
  for (const icon of manifest.icons as { src: string; sizes: string }[]) {
    const img = await page.request.get(`/${icon.src}`);
    expect(img.ok(), icon.src).toBe(true);
    expect(img.headers()['content-type']).toContain('image/png');
  }
  expect((manifest.icons as { purpose: string }[]).some((i) => i.purpose === 'maskable')).toBe(true);
});

test.describe('桌面宽度 / desktop width', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  test('仍是侧栏布局，没有底部栏 / sider layout, no tab bar', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 王芳' }).click();
    await expect(page.getByTestId('user-menu')).toContainText('王芳');
    await expect(page.getByTestId('sider')).toBeVisible();
    await expect(page.getByTestId('mobile-tabbar')).toHaveCount(0);
    await expect(page.getByTestId('current-role')).toHaveText('销售代表');
  });
});
