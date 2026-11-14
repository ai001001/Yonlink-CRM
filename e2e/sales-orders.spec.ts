/**
 * 销售订单 第三轮：端到端回归（已接受报价单生成订单 → 报价单显示订单号 → 跳转订单详情 → 发货 → 取消（填写原因）→
 * 终态提示 → 列表筛选 → 打印页 → 有订单的商机不能删除）。
 * Sales orders round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, searchList, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object = {}) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 确认气泡确认框 / confirm a popconfirm */
async function confirm(page: Page): Promise<void> {
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
}

test('报价单生成销售订单并完成发货与取消 / order lifecycle from a quote', async ({ page }) => {
  await signIn(page);
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 订单客户', address: '苏州市演示路 9 号' });
  const deal = await apiPost(page, '/api/deals', { name: 'E2E 订单商机', accountId: acc.id });
  const product = await apiPost(page, '/api/products', { sku: 'E2E-SO-1', name: 'E2E 订单产品', unit: '台', unitPrice: '500' });
  await apiPost(page, `/api/deals/${deal.id}/items`, { productId: product.id, quantity: '4' });
  const quote = await apiPost(page, '/api/quotes', { dealId: deal.id, taxPercent: '13' });
  await apiPost(page, `/api/quotes/${quote.id}/status`, { status: 'SENT' });
  await apiPost(page, `/api/quotes/${quote.id}/status`, { status: 'ACCEPTED' });

  // 报价单详情 → 生成销售订单（收货地址默认为客户地址）/ quote drawer → create order (address defaults to the account's)
  await page.goto(`/quotes?id=${quote.id}`);
  const quoteDrawer = page.getByRole('dialog', { name: `报价单详情 · ${quote.quoteNumber}` });
  await quoteDrawer.getByRole('button', { name: '生成销售订单' }).click();
  const dialog = page.getByRole('dialog', { name: '生成销售订单' });
  await expect(dialog.getByLabel('主题')).toHaveValue('E2E 订单商机');
  await expect(dialog.getByLabel('收货地址')).toHaveValue('苏州市演示路 9 号');
  await dialog.getByLabel('备注').fill('请附装箱单');
  await dialog.getByRole('button', { name: '生成订单' }).click();
  await expect(page.getByText(/已生成销售订单 SO-\d{4}-\d{4}/)).toBeVisible();

  // 报价单显示订单号，不能再次生成 / the quote shows the order and cannot be ordered again
  const orders = quoteDrawer.getByTestId('quote-orders');
  await expect(orders).toContainText('已确认');
  await expect(quoteDrawer.getByRole('button', { name: '生成销售订单' })).toHaveCount(0);
  const number = ((await orders.getByRole('link').textContent()) ?? '').trim();
  expect(number).toMatch(/^SO-\d{4}-\d{4}$/);
  await orders.getByRole('link', { name: number }).click();

  // 订单详情：金额沿用报价单；发货 / order detail: amounts from the quote; ship
  await expect(page).toHaveURL(/\/sales-orders\?id=/);
  const drawer = page.getByRole('dialog', { name: `销售订单详情 · ${number}` });
  await expect(drawer.getByTestId('quote-total')).toHaveText('¥2,260.00');
  await expect(drawer).toContainText('请附装箱单');
  await drawer.getByRole('button', { name: '标记已发货' }).click();
  await confirm(page);
  await expect(drawer.locator('.ant-descriptions')).toContainText('已发货');
  await expect(drawer.getByRole('button', { name: '确认已交付' })).toBeVisible();

  // 取消（填写原因）后为终态 / cancel with a reason, then the order is final
  await drawer.getByRole('button', { name: '取消订单' }).click();
  const cancel = page.getByRole('dialog', { name: '取消销售订单' });
  await cancel.getByLabel('取消原因').fill('客户改期');
  await cancel.getByRole('button', { name: '取消订单' }).click();
  await expect(drawer.locator('.ant-descriptions')).toContainText('已取消');
  await expect(drawer).toContainText('客户改期');
  await expect(drawer).toContainText('订单已交付或已取消，不能再修改。');
  await expect(drawer.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
  await drawer.getByRole('button', { name: '关闭' }).first().click();

  // 列表按状态筛选 / list filter
  await page.locator('.ant-segmented').getByText('已取消', { exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(number) })).toBeVisible();
  await page.locator('.ant-segmented').getByText('已确认', { exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(number) })).toHaveCount(0);

  // 打印页 / print page
  const print = await page.context().newPage();
  await print.goto(`/print/sales-order?id=${new URL(page.url()).searchParams.get('id')}`);
  await expect(print.getByTestId('order-print')).toContainText(number);
  await expect(print.getByTestId('order-print')).toContainText('E2E 订单产品');
  await print.close();

  // 有订单的商机不能删除 / deals with orders cannot be deleted
  await nav(page, '商机');
  await searchList(page, '搜索商机名称、客户名称', 'E2E 订单商机');
  await page.getByRole('row', { name: /E2E 订单商机/ }).getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByText('该商机已有销售订单，不能删除')).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 订单商机/ })).toBeVisible();
});

test('演示数据：销售订单列表与只读用户 / demo orders for a read-only user', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('周会计');
  await nav(page, '销售订单');
  await expect(page.getByText('共 7 条')).toBeVisible();
  await page.getByRole('row', { name: /已确认/ }).getByRole('button', { name: /^SO-/ }).click();
  const drawer = page.getByRole('dialog', { name: /销售订单详情 · SO-/ });
  await expect(drawer).toContainText('【演示】请随货附带产品合格证与装箱单。');
  await expect(drawer.getByRole('button', { name: '标记已发货' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '取消订单' })).toHaveCount(0);
});
