/**
 * 价格表 第三轮：端到端回归（经理：新建价格表与同名提示 → 设置产品价格 → 指定客户并在客户详情中显示 → 为该客户的商机添加产品，
 * 自动按价格表填入单价并显示来源 → 手工选演示阶梯价格表，数量 50 享受 10% 折扣 → 改为阶梯价并添加阶梯 → 删除价格表后客户
 * 恢复为未指定；销售代表与只读用户只能查看）。基于演示数据。
 * Price books round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList, selectOption } from './helpers';

const SAVE = /保\s*存/;
const BOOK = 'E2E 华南经销价';
const ACCOUNT = '【演示】华南汽配连锁';
const DEAL = 'E2E 价格表商机';
const SKU = 'DT-GK-01-CN';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/**
 * 在下拉中搜索并选择产品（按结果重试）。
 * Search and pick a product in a select, retrying by outcome.
 */
async function pickProduct(page: Page, scope: Locator, label: string): Promise<void> {
  const option = page.locator('.ant-select-dropdown:visible').getByText(new RegExp(`^${SKU} ·`));
  await expect(async () => {
    if (await scope.getByTitle(new RegExp(`^${SKU} ·`)).isVisible()) return;
    if (!(await option.isVisible())) {
      await scope.getByLabel(label, { exact: true }).click({ timeout: 2000 });
      await scope.getByLabel(label, { exact: true }).fill(SKU, { timeout: 2000 });
    }
    await option.click({ timeout: 2000 });
    await expect(scope.getByTitle(new RegExp(`^${SKU} ·`))).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
}

test('经理：价格表维护与商机按价格表取价 / manager: price books and deal pricing', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');

  // 列表：演示价格表，默认只显示启用 / list shows the active demo books
  await nav(page, '价格表');
  await expect(page.getByRole('row', { name: /国内批量阶梯价/ })).toContainText('阶梯价');
  await expect(page.getByRole('row', { name: /北美经销商价格表/ })).toContainText('固定价');
  await expect(page.getByRole('row', { name: /旧版欧洲价格表/ })).toHaveCount(0);

  // 新建；同名（不区分大小写）提示 / create; duplicate name
  for (const name of [BOOK, BOOK.toLowerCase()]) {
    await page.getByRole('button', { name: '新建价格表' }).click();
    const form = page.getByRole('dialog', { name: '新建价格表' });
    await form.getByLabel('价格表名称').fill(name);
    await form.getByRole('button', { name: SAVE }).click();
    if (name === BOOK) await expect(form).toBeHidden();
    else {
      await expect(form.getByText('已有同名价格表')).toBeVisible();
      await form.getByRole('button', { name: /取\s*消/ }).click();
    }
  }

  // 设置产品价格：选择产品后自动带出目录价，改为 80 / set a product price
  await searchList(page, '搜索价格表名称、说明', BOOK);
  await page.getByRole('button', { name: BOOK, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: `价格表详情 · ${BOOK}` });
  const detail = drawer.getByTestId('pricebook-detail');
  await expect(detail.getByTestId('pricebook-entries')).toContainText('还没有产品价格');
  await pickProduct(page, detail, '产品');
  await expect(detail.getByLabel('价格表价')).toHaveValue('85.00');
  await detail.getByLabel('价格表价').fill('80');
  await detail.getByRole('button', { name: '设置价格' }).click();
  const entry = detail.getByTestId('pricebook-entries').getByRole('row', { name: new RegExp(SKU) });
  await expect(entry).toContainText('¥80.00');
  await expect(entry).toContainText('¥85.00');
  await expect(entry).toContainText('-5.9%');

  // 指定客户 / assign an account
  const assign = detail.getByTestId('pricebook-assign');
  const option = page.locator('.ant-select-dropdown:visible').getByTitle(ACCOUNT, { exact: true });
  await expect(async () => {
    if (await assign.getByTitle(ACCOUNT, { exact: true }).isVisible()) return;
    if (!(await option.isVisible())) {
      await assign.locator('#pricebook-account').click({ timeout: 2000 });
      await assign.locator('#pricebook-account').fill('华南汽配', { timeout: 2000 });
    }
    await option.click({ timeout: 2000 });
    await expect(assign.getByTitle(ACCOUNT, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await assign.getByRole('button', { name: '指定客户' }).click();
  await expect(detail.getByTestId('pricebook-accounts')).toContainText(ACCOUNT);
  await closeDrawer(page, drawer);
  await expect(page.getByRole('row', { name: new RegExp(BOOK) })).toContainText('1');

  // 客户详情显示价格表 / the account detail shows the book
  const accounts = await api(page, 'GET', `/api/accounts?q=${encodeURIComponent('华南汽配连锁')}`);
  const account = accounts.items[0];
  await page.goto(`/accounts?id=${account.id}`);
  await expect(page.getByTestId('account-price-book')).toHaveText(BOOK);

  // 为该客户的商机添加产品：自动按价格表填入并显示来源 / a deal for the account is priced from the book
  await api(page, 'POST', '/api/deals', { name: DEAL, accountId: account.id, currency: 'CNY' });
  // 客户详情抽屉仍打开，直接进入商机页 / the account drawer is still open, so go to deals directly
  await page.goto('/deals');
  await searchList(page, '搜索商机名称、客户名称', DEAL);
  await page.getByRole('button', { name: DEAL }).click();
  const dealDrawer = page.getByRole('dialog', { name: new RegExp(`商机详情 · ${DEAL}`) });
  await dealDrawer.getByRole('tab', { name: '产品明细' }).click();
  const panel = dealDrawer.getByTestId('deal-items');
  await pickProduct(page, panel, '产品');
  await expect(panel.getByTestId('price-preview')).toContainText(`按价格表“${BOOK}”：单价 ¥80.00，折扣 0%`);
  await expect(panel.getByLabel('单价')).toHaveValue('80.00');
  await panel.getByRole('button', { name: '添加产品' }).click();
  await expect(panel.getByTestId('items-total')).toHaveText('¥80.00');
  await expect(panel.getByRole('row', { name: new RegExp(SKU) })).toContainText(BOOK);

  // 手工选演示阶梯价格表：数量 50 享受 10% 折扣 / pick the demo tier book: 10% off at 50
  await selectOption(page, panel, '价格表', '【演示】国内批量阶梯价');
  await pickProduct(page, panel, '产品');
  await panel.getByLabel('数量').fill('50');
  await expect(panel.getByTestId('price-preview')).toContainText('按价格表“【演示】国内批量阶梯价”：单价 ¥85.00，折扣 10%');
  await expect(panel.getByLabel('折扣 %')).toHaveValue('10.00');
  await panel.getByRole('button', { name: '添加产品' }).click();
  // 80 + 50 × 85 × 0.9 = 3905 / 80 + 3825
  await expect(panel.getByTestId('items-total')).toHaveText('¥3,905.00');
  await expect(panel.getByRole('row', { name: /国内批量阶梯价/ })).toContainText('10%');
  await closeDrawer(page, dealDrawer);

  // 改为阶梯价并添加阶梯 / switch to differential pricing with a tier
  await nav(page, '价格表');
  await searchList(page, '搜索价格表名称、说明', BOOK);
  await page.getByRole('button', { name: BOOK, exact: true }).click();
  // 抽屉右上角的操作；产品价格行也有编辑、删除按钮 / header actions; entry rows have edit and delete buttons too
  const actions = drawer.locator('.ant-drawer-extra');
  await actions.getByRole('button', { name: /编\s*辑/ }).click();
  const form = page.getByRole('dialog', { name: '编辑价格表' });
  await selectOption(page, form, '定价方式', '阶梯价');
  await form.getByRole('button', { name: '添加阶梯' }).click();
  await form.getByLabel('起始数量 1').fill('20');
  await form.getByLabel('折扣 % 1').fill('6');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form).toBeHidden();
  await expect(detail.getByTestId('pricebook-tiers')).toContainText('20 及以上：折扣 6%');

  // 删除：提示已指定的客户数；客户恢复为未指定 / delete warns about assigned accounts
  await actions.getByRole('button', { name: /删\s*除/ }).click();
  await expect(page.getByText('该价格表已指定给 1 个客户')).toBeVisible();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('row', { name: new RegExp(BOOK) })).toHaveCount(0);
  await page.goto(`/accounts?id=${account.id}`);
  await expect(page.getByText('未指定（使用产品目录价）')).toBeVisible();
});

for (const who of ['王芳', '周会计']) {
  test(`${who}：只能查看价格表 / ${who}: read-only price books`, async ({ page }) => {
    await demoSignIn(page, who);
    await nav(page, '价格表');
    await expect(page.getByRole('button', { name: '新建价格表' })).toHaveCount(0);
    await page.getByRole('button', { name: '【演示】北美经销商价格表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: /价格表详情 · 【演示】北美经销商价格表/ });
    const detail = drawer.getByTestId('pricebook-detail');
    await expect(detail.getByTestId('pricebook-entries')).toContainText('DT-HD-11L');
    // 目录价 980，价格表价为 88% / list price is 88% of 980
    await expect(detail.getByTestId('pricebook-entries').getByRole('row', { name: /DT-HD-11L/ })).toContainText('USD 862.40');
    await expect(detail.getByRole('button', { name: '设置价格' })).toHaveCount(0);
    await expect(detail.getByTestId('pricebook-assign')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
    await expect(detail.getByTestId('pricebook-accounts')).toContainText('【演示】北湖商用车配件分销公司');
    await closeDrawer(page, drawer);
  });
}
