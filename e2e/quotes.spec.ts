/**
 * 报价单 第三轮：端到端回归（商机生成报价单 → 编辑草稿 → 发送 → 接受 → 列表筛选 → 打印页；只读用户只读）。
 * Quotes round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, searchList, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiPost(page: Page, path: string, data: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** 确认气泡确认框 / confirm a popconfirm */
async function confirm(page: Page): Promise<void> {
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
}

test('商机生成报价单、发送、接受、打印 / quote lifecycle', async ({ page }) => {
  await signIn(page);
  const acc = await apiPost(page, '/api/accounts', { name: 'E2E 报价客户', phone: '021-55551234', address: '上海市演示路 8 号' });
  const deal = await apiPost(page, '/api/deals', { name: 'E2E 报价商机', accountId: acc.id });
  const product = await apiPost(page, '/api/products', { sku: 'E2E-Q-1', name: 'E2E 报价产品', unit: '台', unitPrice: '1000' });
  await apiPost(page, `/api/deals/${deal.id}/items`, { productId: product.id, quantity: '2' });

  // 商机详情 → 报价单页签 → 生成 / generate from the deal
  await nav(page, '商机');
  await searchList(page, '搜索商机名称、客户名称', 'E2E 报价商机');
  await page.getByRole('button', { name: 'E2E 报价商机' }).click();
  const dealDrawer = page.getByRole('dialog', { name: /商机详情 · E2E 报价商机/ });
  await dealDrawer.getByRole('tab', { name: '报价单' }).click();
  const panel = dealDrawer.getByTestId('deal-quotes');
  await expect(panel).toContainText('暂无数据');
  await panel.getByRole('button', { name: '生成报价单' }).click();
  const createDialog = page.getByRole('dialog', { name: '生成报价单' });
  await expect(createDialog.getByLabel('报价主题')).toHaveValue('E2E 报价商机');
  await createDialog.getByLabel('税率 %').fill('13');
  await createDialog.getByLabel('条款与说明').fill('30% 预付款，余款发货前付清');
  await createDialog.getByRole('button', { name: /保\s*存/ }).click();

  // 报价单详情自动打开 / the quote drawer opens
  const quote = page.getByRole('dialog', { name: /报价单详情 · QT-\d{4}-\d{4}/ });
  await expect(quote.getByTestId('quote-total')).toHaveText('¥2,260.00');
  await expect(quote.getByTestId('quote-subtotal')).toHaveText('¥2,000.00');
  await expect(quote.getByTestId('quote-tax')).toHaveText('¥260.00');
  await expect(quote).toContainText('草稿');
  const number = ((await quote.locator('.ant-drawer-title').textContent()) ?? '').match(/QT-\d{4}-\d{4}/)?.[0] ?? '';
  expect(number).toMatch(/^QT-\d{4}-\d{4}$/);

  // 编辑草稿 / edit the draft
  await quote.getByRole('button', { name: /编\s*辑/ }).click();
  const edit = page.getByRole('dialog', { name: '编辑报价单' });
  await edit.getByLabel('报价主题').fill('E2E 报价商机 - 修订版');
  await edit.getByLabel('内部备注').fill('仅内部可见的底价说明');
  await edit.getByRole('button', { name: /保\s*存/ }).click();
  await expect(edit).toBeHidden();
  await expect(quote).toContainText('E2E 报价商机 - 修订版');

  // 发送：之后不能编辑 / send: no longer editable
  await quote.getByRole('button', { name: '标记为已发送' }).click();
  await confirm(page);
  await expect(quote).toContainText('只有草稿可以修改');
  await expect(quote.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
  await expect(quote.getByRole('button', { name: '从商机同步明细' })).toHaveCount(0);

  // 打印页：新标签页，显示客户、明细、合计与条款，不显示内部备注 / print page
  const [print] = await Promise.all([page.context().waitForEvent('page'), quote.getByRole('link', { name: /打印/ }).click()]);
  await print.waitForLoadState();
  const sheet = print.getByTestId('quote-print');
  await expect(sheet).toContainText(number);
  await expect(sheet).toContainText('E2E 报价客户');
  await expect(sheet).toContainText('上海市演示路 8 号');
  await expect(sheet).toContainText('E2E-Q-1');
  await expect(sheet.getByTestId('quote-total')).toHaveText('¥2,260.00');
  await expect(sheet).toContainText('30% 预付款，余款发货前付清');
  await expect(sheet).not.toContainText('仅内部可见的底价说明');
  await print.close();

  // 客户接受 / accepted
  await quote.getByRole('button', { name: '客户已接受' }).click();
  await confirm(page);
  await expect(quote).toContainText('已接受');
  await expect(quote.getByRole('button', { name: '退回草稿' })).toHaveCount(0);
  await quote.getByRole('button', { name: 'Close' }).or(quote.locator('.ant-drawer-close')).first().click();
  await expect(quote).toBeHidden();
  await expect(panel.getByRole('row', { name: new RegExp(number) })).toContainText('已接受');
  await dealDrawer.locator('.ant-drawer-close').first().click();
  await expect(dealDrawer).toBeHidden();

  // 报价单列表：筛选与搜索 / list filter and search
  await nav(page, '报价单');
  await page.getByText('已接受', { exact: true }).first().click();
  await searchList(page, '搜索报价单号、主题、商机、客户', number);
  const row = page.getByRole('row', { name: new RegExp(number) });
  await expect(row).toContainText('E2E 报价客户');
  await expect(row).toContainText('¥2,260.00');

  // 审计日志 / audit log
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table')).toContainText('报价单');
});

test('只读用户可查看报价单但不能操作 / read-only user views quotes only', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '报价单');
  const first = page.getByRole('button', { name: /^QT-\d{4}-\d{4}$/ }).first();
  await expect(first).toBeVisible();
  await first.click();
  const quote = page.getByRole('dialog', { name: /报价单详情/ });
  await expect(quote.getByTestId('quote-total')).toBeVisible();
  await expect(quote.getByRole('link', { name: /打印/ })).toBeVisible();
  for (const name of ['标记为已发送', '客户已接受', '客户已拒绝', '退回草稿', '从商机同步明细']) {
    await expect(quote.getByRole('button', { name })).toHaveCount(0);
  }
  await expect(quote.getByRole('button', { name: /编\s*辑|删\s*除/ })).toHaveCount(0);
});
