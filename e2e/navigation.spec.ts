/**
 * 导航结构 第三轮：端到端回归（按 Zoho CRM 模块分组的左侧导航）。四种角色分别检查：分组标题与菜单顺序符合权限；
 * 逐个点击每个菜单，地址正确、菜单高亮、页面内容渲染、无未捕获的页面错误或控制台错误；通知中心从铃铛进入。
 * Navigation round 3: the Zoho-style grouped side menu. For each of four roles: group headers and entries match the
 * permissions; every entry opens with the right URL, highlight and rendered content and no page or console errors;
 * the notification centre is reached from the bell.
 */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/** 菜单项与路径 / menu entries and paths */
const PATHS: Record<string, string> = {
  工作台: '/',
  线索: '/leads',
  联系人: '/contacts',
  客户: '/accounts',
  商机: '/deals',
  销售预测: '/forecasts',
  市场活动: '/campaigns',
  跟进: '/activities',
  产品: '/products',
  报价单: '/quotes',
  销售订单: '/sales-orders',
  发票: '/invoices',
  服务工单: '/tickets',
  知识库: '/kb',
  报表: '/reports',
  用户管理: '/users',
  汇率: '/exchange-rates',
  查重合并: '/duplicates',
  回收站: '/recycle-bin',
  审计日志: '/audit-logs',
};

const BUSINESS = ['工作台', '线索', '联系人', '客户', '商机', '销售预测', '市场活动', '跟进', '产品', '报价单', '销售订单', '发票', '服务工单', '知识库', '报表'];
const GROUPS = ['销售', '营销', '活动', '库存', '服务', '分析', '设置'];

/** 各角色应看到的菜单（按顺序）/ entries each role should see, in order */
const ROLES: { name: string; login: (page: Page) => Promise<void>; items: string[] }[] = [
  { name: '系统管理员', login: signIn, items: [...BUSINESS, '用户管理', '汇率', '查重合并', '回收站', '审计日志'] },
  { name: '销售经理', login: (p) => demo(p, '郑经理'), items: [...BUSINESS, '汇率', '查重合并', '回收站'] },
  { name: '销售代表', login: (p) => demo(p, '王芳'), items: [...BUSINESS, '汇率', '查重合并'] },
  { name: '只读用户', login: (p) => demo(p, '周会计'), items: [...BUSINESS, '汇率', '查重合并'] },
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
    const menu = page.getByRole('menu');

    // 分组标题与菜单顺序 / group headers and entry order
    await expect(menu.locator('.ant-menu-item-group-title')).toHaveText(GROUPS);
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
