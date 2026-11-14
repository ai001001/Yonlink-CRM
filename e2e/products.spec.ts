/**
 * 产品目录与商机产品明细 第三轮：端到端回归
 * （新增产品 → SKU 重复提示 → 商机添加明细 → 金额自动计算 → 编辑/删除明细 → 金额锁定 → 使用中不能删除 → 停用；只读用户只读）。
 * Product catalog and deal line items round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList, signIn } from './helpers';

const PRODUCTS = '搜索 SKU、名称、分类';
const DEALS = '搜索商机名称、客户名称';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 新增产品 / create a product through the form */
async function createProduct(page: Page, sku: string, name: string, price: string): Promise<void> {
  await page.getByRole('button', { name: '新增产品' }).click();
  const dialog = page.getByRole('dialog', { name: '新增产品' });
  await dialog.getByLabel('SKU').fill(sku);
  await dialog.getByLabel('产品名称').fill(name);
  await dialog.getByLabel('单价').fill(price);
  await dialog.getByRole('button', { name: /确\s*定|OK|保\s*存/ }).click();
}

test('产品目录与商机明细 / product catalog and deal line items', async ({ page }) => {
  await signIn(page);
  await nav(page, '产品');
  await expect(page.getByText('产品目录').first()).toBeVisible();

  // 新增产品：SKU 自动转大写 / SKU is upper-cased
  await createProduct(page, 'e2e-pump', 'E2E 增压泵', '1000');
  const row = page.getByRole('row', { name: /E2E-PUMP/ });
  await expect(row).toContainText('E2E 增压泵');
  await expect(row).toContainText('¥1,000.00');
  await expect(row).toContainText('启用');

  // SKU 重复（不区分大小写）提示 / duplicate SKU message
  await createProduct(page, 'E2E-pump', '重复', '1');
  await expect(page.getByText('该 SKU 已存在').first()).toBeVisible();
  await page.getByRole('dialog', { name: '新增产品' }).getByRole('button', { name: /取\s*消|Cancel/ }).click();

  // 商机添加产品明细 / add line items to a deal
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 产品客户' });
  await apiPost(page, '/api/deals', { name: 'E2E 产品商机', accountId: acc.id, amount: '5' });
  await nav(page, '商机');
  await searchList(page, DEALS, 'E2E 产品商机');
  await page.getByRole('button', { name: 'E2E 产品商机' }).click();
  const drawer = page.getByRole('dialog', { name: /商机详情 · E2E 产品商机/ });
  await drawer.getByRole('tab', { name: '产品明细' }).click();
  const panel = drawer.getByTestId('deal-items');
  await expect(panel).toContainText('商机金额 = 产品明细合计');

  await expect(async () => {
    await page.keyboard.press('Escape');
    await panel.getByLabel('产品').click();
    await page.locator('.ant-select-dropdown:visible').getByText(/E2E-PUMP/).click({ timeout: 2000 });
    await expect(panel.getByLabel('单价')).toHaveValue('1000.00', { timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await panel.getByLabel('数量').fill('3');
  await panel.getByLabel('折扣 %').fill('10');
  await panel.getByRole('button', { name: '添加产品' }).click();
  await expect(panel.getByTestId('items-total')).toHaveText('¥2,700.00');
  const itemRow = panel.getByRole('row', { name: /E2E-PUMP/ });
  await expect(itemRow).toContainText('3 件');
  await expect(itemRow).toContainText('10%');

  // 编辑明细：数量改为 2 → 合计 1800 / edit the item
  await itemRow.getByRole('button', { name: /编\s*辑/ }).click();
  const edit = page.getByRole('dialog', { name: 'E2E-PUMP · E2E 增压泵' });
  await edit.getByLabel('数量').fill('2');
  await edit.getByRole('button', { name: /保\s*存/ }).click();
  await expect(edit).toBeHidden();
  await expect(panel.getByTestId('items-total')).toHaveText('¥1,800.00');

  // 列表中的商机金额随明细更新 / the deal amount in the list follows the items
  await closeDrawer(page, drawer);
  await expect(drawer).toBeHidden();
  const dealRow = page.getByRole('row', { name: /E2E 产品商机/ });
  await expect(dealRow).toContainText('¥1,800.00');

  // 编辑商机：金额与币种被锁定 / amount and currency are locked
  await dealRow.getByRole('button', { name: /编\s*辑/ }).click();
  const dealForm = page.getByRole('dialog', { name: '编辑商机' });
  await expect(dealForm.getByText('该商机已有产品明细，金额由明细自动计算，币种不可修改')).toBeVisible();
  await expect(dealForm.getByLabel('金额')).toBeDisabled();
  await dealForm.getByRole('button', { name: /取\s*消|Cancel/ }).click();

  // 使用中的产品不能删除，可以停用 / an in-use product cannot be deleted but can be deactivated
  await nav(page, '产品');
  await searchList(page, PRODUCTS, 'E2E-PUMP');
  const productRow = page.getByRole('row', { name: /E2E-PUMP/ });
  await expect(productRow.locator('td').nth(6)).toHaveText('1');
  await productRow.getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByText('该产品已被商机使用，不能删除，可改为停用').first()).toBeVisible();
  await productRow.getByRole('button', { name: /停\s*用/ }).click();
  await expect(productRow).toHaveCount(0);
  await page.getByText('已停用', { exact: true }).first().click();
  await expect(page.getByRole('row', { name: /E2E-PUMP/ })).toContainText('已停用');

  // 删除明细后金额回到 0，可以手工改金额 / removing the item resets the total
  await nav(page, '商机');
  await searchList(page, DEALS, 'E2E 产品商机');
  await page.getByRole('button', { name: 'E2E 产品商机' }).click();
  await drawer.getByRole('tab', { name: '产品明细' }).click();
  // 停用的产品不出现在可选列表中，但已有明细仍显示 / inactive products are not selectable, existing rows remain
  await expect(panel.getByRole('row', { name: /E2E-PUMP/ })).toBeVisible();
  await panel.getByRole('row', { name: /E2E-PUMP/ }).getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(panel.getByTestId('items-total')).toHaveText('¥0.00');

  // 审计日志记录产品与明细操作 / the audit log records product and item actions
  await closeDrawer(page, drawer);
  await expect(drawer).toBeHidden();
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table')).toContainText('产品');
});

test('只读用户只能查看产品目录 / read-only user only views the catalog', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '产品');
  await expect(page.getByRole('row', { name: /DT-/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '新增产品' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /停\s*用/ })).toHaveCount(0);
});
