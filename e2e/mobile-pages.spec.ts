/**
 * 移动端 第二轮：集成测试（四种角色在手机宽度 390 下逐个打开抽屉菜单中的全部页面：不横向超宽、内容渲染、菜单高亮、
 * 无页面或控制台错误；较窄的 360 宽度下销售代表的常用页面；公开页面：登录页、客户门户登录页）。
 * Mobile round 2: every menu page per role on a 390-wide phone, common pages at 360, and the public pages.
 */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/** 演示账号登录 / demo sign-in */
async function demo(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
}

/** 记录页面错误 / collect page errors */
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console ${m.text()} ${m.location().url}`);
  });
  // 记录 404 的地址，便于定位 / record 404 URLs for diagnosis
  page.on('response', (r) => {
    if (r.status() === 404) errors.push(`404 ${r.url()}`);
  });
  return errors;
}

/** 当前页面横向宽度 / horizontal extent of the page */
const width = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

const ROLES: { name: string; login: (page: Page) => Promise<void> }[] = [
  { name: '系统管理员', login: signIn },
  { name: '销售经理', login: (p) => demo(p, '郑经理') },
  { name: '销售代表', login: (p) => demo(p, '王芳') },
  { name: '只读用户', login: (p) => demo(p, '周会计') },
];

for (const role of ROLES) {
  test(`手机：${role.name}的全部页面 / every page as ${role.name}`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors = watch(page);
    await role.login(page);
    await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
    await page.getByTestId('mobile-menu-toggle').click();
    const menu = page.getByTestId('mobile-menu');
    const labels = (await menu.locator('.ant-menu-item').allInnerTexts()).map((x) => x.trim());
    expect(labels.length).toBeGreaterThan(10);
    await page.keyboard.press('Escape');
    for (const label of labels) {
      // 从抽屉菜单进入，按结果重试（抽屉打开动画期间点击可能落空）/ open from the drawer, retrying by outcome
      await expect(async () => {
        if (!(await menu.isVisible())) await page.getByTestId('mobile-menu-toggle').click({ timeout: 2000 });
        await menu.getByRole('link', { name: label, exact: true }).click({ timeout: 2000 });
        await expect(menu).toBeHidden({ timeout: 3000 });
      }).toPass({ timeout: 20000 });
      await expect(page.getByRole('main').locator('.ant-card').first(), label).toBeVisible();
      await expect(page.getByText("This page couldn't load")).toHaveCount(0);
      // 等列表数据加载后再量宽度 / measure after the data loaded
      await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 15000 });
      expect(await width(page), label).toBeLessThanOrEqual(390);
      await page.getByTestId('mobile-menu-toggle').click();
      await expect(menu.locator('.ant-menu-item-selected'), label).toHaveText(label);
      await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });
}

test.describe('较窄的手机 / narrower phones', () => {
  test.use({ viewport: { width: 360, height: 740 } });
  test('360 宽度下常用页面不超宽 / common pages fit at 360', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watch(page);
    await demo(page, '王芳');
    for (const path of ['/', '/leads', '/contacts', '/accounts', '/deals', '/activities', '/tickets', '/quotes', '/reports', '/profile']) {
      await page.goto(path);
      await expect(page.getByRole('main').locator('.ant-card').first(), path).toBeVisible();
      await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 15000 });
      expect(await width(page), path).toBeLessThanOrEqual(360);
    }
    // 看板视图也在内部滚动 / the board view scrolls inside itself too
    await page.goto('/deals');
    await page.getByText('看板', { exact: true }).click();
    await expect(page.getByTestId('board-col-QUALIFICATION')).toBeVisible();
    expect(await width(page)).toBeLessThanOrEqual(360);
    expect(errors).toEqual([]);
  });
});

test('公开页面：登录页与客户门户登录页 / public pages', async ({ page }) => {
  for (const path of ['/login', '/portal/login']) {
    await page.goto(path);
    await expect(page.locator('.ant-card').first(), path).toBeVisible();
    expect(await width(page), path).toBeLessThanOrEqual(390);
  }
});
