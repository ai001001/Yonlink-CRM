/**
 * 导航结构 第三轮：端到端回归（按 Zoho CRM 模块分组的左侧导航）。四种角色分别检查：分组标题与菜单顺序符合权限；
 * 逐个点击每个菜单，地址正确、菜单高亮、页面内容渲染、无未捕获的页面错误或控制台错误；通知中心从铃铛进入。
 * 另测侧栏折叠：全部收起（保留当前分组）、全部展开、单组折叠、收起侧栏为图标栏（弹出分组）、刷新后保持；
 * 咨询方式：侧栏底部、顶部栏、登录页显示 QQ 并可复制。
 * Navigation round 3: the Zoho-style grouped side menu. For each of four roles: group headers and entries match the
 * permissions; every entry opens with the right URL, highlight and rendered content and no page or console errors;
 * the notification centre is reached from the bell.
 */
import { expect, test, type Page } from '@playwright/test';
import { sideMenu, signIn } from './helpers';

/** 菜单项与路径 / menu entries and paths */
const PATHS: Record<string, string> = {
  工作台: '/',
  线索: '/leads',
  联系人: '/contacts',
  客户: '/accounts',
  商机: '/deals',
  销售预测: '/forecasts',
  市场活动: '/campaigns',
  网页表单: '/web-forms',
  跟进: '/activities',
  产品: '/products',
  价格表: '/price-books',
  报价单: '/quotes',
  销售订单: '/sales-orders',
  采购单: '/purchase-orders',
  发票: '/invoices',
  供应商: '/vendors',
  服务工单: '/tickets',
  知识库: '/kb',
  报表: '/reports',
  用户管理: '/users',
  汇率: '/exchange-rates',
  查重合并: '/duplicates',
  回收站: '/recycle-bin',
  审计日志: '/audit-logs',
};

const BUSINESS = ['工作台', '线索', '联系人', '客户', '商机', '销售预测', '市场活动', '网页表单', '跟进', '产品', '价格表', '报价单', '销售订单', '发票', '服务工单', '知识库', '报表'];
/** 有 purchase.read 的角色在“库存”组多出采购单（销售订单后）与供应商（发票后）/ roles with purchase.read also see purchase orders and vendors */
const WITH_PURCHASE = ['工作台', '线索', '联系人', '客户', '商机', '销售预测', '市场活动', '网页表单', '跟进', '产品', '价格表', '报价单', '销售订单', '采购单', '发票', '供应商', '服务工单', '知识库', '报表'];
const GROUPS = ['销售', '营销', '活动', '库存', '服务', '分析', '设置'];

/** 各角色应看到的菜单（按顺序）/ entries each role should see, in order */
const ROLES: { name: string; login: (page: Page) => Promise<void>; items: string[] }[] = [
  { name: '系统管理员', login: signIn, items: [...WITH_PURCHASE, '用户管理', '汇率', '查重合并', '回收站', '审计日志'] },
  { name: '销售经理', login: (p) => demo(p, '郑经理'), items: [...WITH_PURCHASE, '汇率', '查重合并', '回收站'] },
  { name: '销售代表', login: (p) => demo(p, '王芳'), items: [...BUSINESS, '汇率', '查重合并'] },
  { name: '只读用户', login: (p) => demo(p, '周会计'), items: [...WITH_PURCHASE, '汇率', '查重合并'] },
];

/** 演示账号登录 / demo sign-in */
async function demo(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

for (const role of ROLES) {
  test(`导航：${role.name} / navigation as ${role.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
    // 记录 404 的地址，便于定位（包括网站图标）/ record 404 URLs for diagnosis (the favicon included)
    page.on('response', (r) => {
      if (r.status() === 404) errors.push(`404 ${r.url()}`);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console ${m.text()}`);
    });
    await role.login(page);
    const menu = sideMenu(page);

    // 分组标题与菜单顺序（默认全部展开）/ group headers and entry order (all groups open by default)
    await expect(menu.locator('.ant-menu-submenu-title')).toHaveText(GROUPS);
    await expect(menu.locator('.ant-menu-item')).toHaveText(role.items);
    // 通知中心不在导航中 / the notification centre is not in the menu
    await expect(menu.getByRole('link', { name: '通知中心' })).toHaveCount(0);

    // 逐个打开 / open every entry
    for (const label of role.items) {
      await menu.getByRole('link', { name: label, exact: true }).click();
      const path = PATHS[label]!;
      await expect(page).toHaveURL(new RegExp(`/${path === '/' ? '' : `${path.slice(1)}/?`}(\\?.*)?$`));
      await expect(menu.locator('.ant-menu-item-selected')).toHaveText(label);
      // 页面已渲染内容，且不是错误页 / content rendered, not an error page
      await expect(page.getByRole('main').locator('.ant-card').first()).toBeVisible();
      await expect(page.getByText("This page couldn't load")).toHaveCount(0);
    }

    // 通知中心从铃铛进入 / the notification centre from the bell
    await page.getByTestId('notification-bell').click();
    await page.getByTestId('notification-popover').getByRole('link', { name: '查看全部通知' }).click();
    await expect(page).toHaveURL(/\/notifications\/?$/);
    await expect(page.getByRole('main').locator('.ant-card').first()).toBeVisible();
    // 不在导航中的页面不高亮任何菜单 / pages outside the menu highlight nothing
    await expect(menu.locator('.ant-menu-item-selected')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
}

test('侧栏折叠：全部收起、全部展开、收起侧栏与刷新保持 / sidebar folding', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const menu = sideMenu(page);
  const toolbar = page.getByTestId('sider-toolbar');
  const link = (name: string) => menu.getByRole('link', { name, exact: true });
  await link('线索').click();
  await expect(page).toHaveURL(/\/leads\/?$/);

  // 全部收起：只保留当前页面所在的“销售”组 / collapse all keeps the current "Sales" group open
  await toolbar.getByRole('button', { name: '全部收起' }).click();
  await expect(link('联系人')).toBeVisible();
  for (const name of ['市场活动', '跟进', '产品', '服务工单', '报表', '汇率']) await expect(link(name)).toBeHidden();
  await expect(menu.locator('.ant-menu-submenu-open > .ant-menu-submenu-title')).toHaveText(['销售']);

  // 单独展开一组 / open one group
  await menu.locator('.ant-menu-submenu-title', { hasText: '服务' }).click();
  await expect(link('知识库')).toBeVisible();

  // 刷新后保持 / persists after reload
  await page.reload();
  await expect(link('知识库')).toBeVisible();
  await expect(link('产品')).toBeHidden();

  // 全部展开 / expand all
  await toolbar.getByRole('button', { name: '全部展开' }).click();
  for (const name of ['市场活动', '跟进', '产品', '服务工单', '报表', '汇率']) await expect(link(name)).toBeVisible();

  // 收起侧栏为图标栏：分组以弹出方式显示 / collapse the sidebar to an icon rail; groups pop out
  const sider = page.getByTestId('sider');
  const wide = (await sider.boundingBox())!.width;
  await toolbar.getByRole('button', { name: /收起侧栏/ }).click();
  await expect(toolbar).toHaveCount(0);
  await expect.poll(async () => (await sider.boundingBox())!.width).toBeLessThan(wide / 2);
  await expect(page.getByTestId('contact-icon')).toBeVisible();
  // 按结果重试：悬停弹出层的打开动画期间点击可能落空，弹出层随后关闭 / retry by outcome: a click during the pop-out
  // animation can miss and the pop-out then closes
  const group = menu.locator('.ant-menu-submenu', { has: page.locator('.anticon-customer-service') }).first();
  const popup = page.locator('.ant-menu-submenu-popup:visible');
  await expect(async () => {
    await group.hover();
    await popup.getByRole('link', { name: '服务工单', exact: true }).click({ timeout: 3000 });
    await expect(page).toHaveURL(/\/tickets\/?$/, { timeout: 3000 });
  }).toPass({ timeout: 30000 });

  // 刷新后仍为图标栏；顶部按钮展开 / still collapsed after reload; the header button expands it
  await page.reload();
  await expect(page.getByTestId('contact-icon')).toBeVisible();
  await page.getByTestId('sider-toggle').click();
  await expect(toolbar).toBeVisible();
  await expect(page.getByTestId('contact-block')).toBeVisible();
});

test('咨询方式：侧栏、顶部栏、登录页显示并可复制 / contact details', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/login');
  const card = page.getByTestId('contact-card');
  await expect(card).toContainText('咨询方式：QQ 3313395633（学无止境）');
  await card.getByRole('button', { name: /复制QQ号/ }).click();
  await expect(page.getByText('已复制QQ号 3313395633')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('3313395633');

  await signIn(page);
  const block = page.getByTestId('contact-block');
  await expect(block).toContainText('咨询方式');
  await expect(block).toContainText('QQ：3313395633');
  await expect(block).toContainText('学无止境');
  await expect(page.getByTestId('contact-pill')).toHaveText('咨询QQ：3313395633（学无止境）');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByTestId('contact-pill').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('3313395633');

  // 英文界面 / English
  await page.getByText('English', { exact: true }).click();
  await expect(page.getByTestId('contact-block')).toContainText('Xue Wu Zhi Jing');
  await expect(page.getByTestId('contact-pill')).toHaveText('QQ: 3313395633 (Xue Wu Zhi Jing)');
  await page.getByText('中文', { exact: true }).click();
});
