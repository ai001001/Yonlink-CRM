/**
 * 发票 第三轮：端到端回归（订单生成发票 → 订单显示发票、不能取消 → 部分收款 → 撤销 → 付清 → 打印页；
 * 只读用户查看演示发票与逾期筛选）。
 * Invoices round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, signIn } from './helpers';

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

test('订单生成发票、收款、撤销、付清 / invoice lifecycle', async ({ page }) => {
  await signIn(page);
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 发票客户' });
  const deal = await apiPost(page, '/api/deals', { name: 'E2E 发票商机', accountId: acc.id });
  const product = await apiPost(page, '/api/products', { sku: 'E2E-INV-1', name: 'E2E 发票产品', unit: '台', unitPrice: '500' });
  await apiPost(page, `/api/deals/${deal.id}/items`, { productId: product.id, quantity: '4' });
  const quote = await apiPost(page, '/api/quotes', { dealId: deal.id, taxPercent: '13' });
  await apiPost(page, `/api/quotes/${quote.id}/status`, { status: 'SENT' });
  await apiPost(page, `/api/quotes/${quote.id}/status`, { status: 'ACCEPTED' });
  const order = await apiPost(page, '/api/sales-orders', { quoteId: quote.id, shippingAddress: '杭州市演示路 6 号' });

  // 订单详情 → 生成发票（开票地址默认为收货地址）/ order drawer → create invoice
  await page.goto(`/sales-orders?id=${order.id}`);
  const orderDrawer = page.getByRole('dialog', { name: `销售订单详情 · ${order.orderNumber}` });
  await orderDrawer.getByRole('button', { name: '生成发票' }).click();
  const dialog = page.getByRole('dialog', { name: '生成发票' });
  await expect(dialog.getByLabel('开票地址')).toHaveValue('杭州市演示路 6 号');
  await dialog.getByRole('button', { name: '生成发票' }).click();
  await expect(page.getByText(/已生成发票 INV-\d{4}-\d{4}/)).toBeVisible();
  const invoices = orderDrawer.getByTestId('order-invoices');
  await expect(invoices).toContainText('未付款');

  // 有发票的订单不能取消 / an invoiced order cannot be cancelled
  await orderDrawer.getByRole('button', { name: '取消订单' }).click();
  await page.getByRole('dialog', { name: '取消销售订单' }).getByRole('button', { name: '取消订单' }).click();
  await expect(page.getByText('该订单已有未作废的发票，不能取消；请先作废发票')).toBeVisible();
  await page.getByRole('dialog', { name: '取消销售订单' }).getByRole('button', { name: /^取\s*消$/ }).click();

  // 跳转发票详情 / open the invoice
  const number = ((await invoices.getByRole('link').textContent()) ?? '').trim();
  await invoices.getByRole('link', { name: number }).click();
  await expect(page).toHaveURL(/\/invoices\?id=/);
  const drawer = page.getByRole('dialog', { name: `发票详情 · ${number}` });
  await expect(drawer.getByTestId('invoice-balance')).toHaveText('¥2,260.00');

  // 部分收款 / partial payment
  await drawer.getByRole('button', { name: '登记收款' }).click();
  const payDialog = page.getByRole('dialog', { name: '登记收款' });
  await expect(payDialog.getByLabel('金额')).toHaveValue('2260.00');
  await payDialog.getByLabel('金额').fill('1000');
  await payDialog.getByLabel('凭证号').fill('TT-E2E-1');
  await payDialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(payDialog).toBeHidden();
  await expect(drawer.locator('.ant-descriptions')).toContainText('部分付款');
  await expect(drawer.getByTestId('invoice-balance')).toHaveText('¥1,260.00');
  await expect(drawer.getByTestId('invoice-payments')).toContainText('TT-E2E-1');
  await expect(drawer.getByRole('button', { name: '作废发票' })).toHaveCount(0);

  // 撤销后余额恢复 / reverting restores the balance
  await drawer.getByTestId('invoice-payments').getByRole('button', { name: '撤销' }).click();
  await confirm(page);
  await expect(drawer.getByTestId('invoice-balance')).toHaveText('¥2,260.00');
  await expect(drawer.locator('.ant-descriptions')).toContainText('未付款');

  // 一次付清（默认金额为余额）/ pay in full (the amount defaults to the balance)
  await drawer.getByRole('button', { name: '登记收款' }).click();
  // 等对话框就绪（金额已自动填为余额）再保存，与第一次打开时一致 / wait until the dialog is ready, as on the first open
  await expect(payDialog.getByLabel('金额')).toHaveValue('2260.00');
  await payDialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(payDialog).toBeHidden();
  await expect(drawer.locator('.ant-descriptions')).toContainText('已付清');
  await expect(drawer.getByTestId('invoice-balance')).toHaveText('¥0.00');
  await expect(drawer.getByRole('button', { name: '登记收款' })).toHaveCount(0);

  // 打印页 / print page
  const print = await page.context().newPage();
  await print.goto(`/print/invoice?id=${new URL(page.url()).searchParams.get('id')}`);
  await expect(print.getByTestId('invoice-print')).toContainText(number);
  await expect(print.getByTestId('invoice-print')).toContainText('E2E 发票产品');
  await print.close();
});

test('只读用户：查看演示发票与逾期筛选 / read-only user and the overdue filter', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('user-menu')).toContainText('周会计');
  await nav(page, '发票');
  await expect(page.getByText('共 5 条')).toBeVisible();
  await page.locator('.ant-segmented').getByText('逾期', { exact: true }).click();
  await expect(page.getByText('共 2 条')).toBeVisible();
  await page.getByRole('row', { name: /部分付款/ }).getByRole('button', { name: /^INV-/ }).click();
  const drawer = page.getByRole('dialog', { name: /发票详情 · INV-/ });
  await expect(drawer.getByTestId('invoice-payments')).toContainText('TT-DEMO-004');
  await expect(drawer.getByRole('button', { name: '登记收款' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '撤销' })).toHaveCount(0);
});
