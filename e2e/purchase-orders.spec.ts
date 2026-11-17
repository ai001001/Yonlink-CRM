/**
 * 供应商与采购单 第三轮：端到端回归（经理：新建供应商与同名提示 → 由演示销售订单生成采购单（复制明细）→ 填写单价 → 下单 →
 * 分批收货至已到货 → 打印入口；只读用户只能查看；销售代表看不到采购菜单）。基于演示数据。
 * Vendors and purchase orders round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, selectOption, sideMenu } from './helpers';

const SAVE = /保\s*存/;
const VENDOR = 'E2E 苏州精密零件厂';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('经理：供应商与以销定采的完整流程 / manager: vendor and purchase-to-order flow', async ({ page }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '郑经理');

  // 新建供应商；同名提示 / create a vendor; duplicate name
  await nav(page, '供应商');
  await expect(page.getByRole('row', { name: /宁波精工铸造/ })).toBeVisible();
  for (const name of [VENDOR, VENDOR.toLowerCase()]) {
    await page.getByRole('button', { name: '新建供应商' }).click();
    const form = page.getByRole('dialog', { name: '新建供应商' });
    await form.getByLabel('供应商名称').fill(name);
    await form.getByLabel('付款条件').fill('月结 30 天');
    await form.getByRole('button', { name: SAVE }).click();
    if (name === VENDOR) await expect(form).toBeHidden();
    else {
      await expect(form.getByText('已有同名供应商')).toBeVisible();
      await form.getByRole('button', { name: /取\s*消/ }).click();
    }
  }
  await expect(page.getByRole('row', { name: new RegExp(VENDOR) })).toContainText('月结 30 天');

  // 由销售订单生成采购单 / create from a sales order
  await nav(page, '销售订单');
  await page.getByRole('button', { name: /^SO-\d{4}-0001$/ }).click();
  const order = page.getByRole('dialog', { name: /订单详情/ });
  const purchases = order.getByTestId('order-purchases');
  await expect(purchases.getByRole('link', { name: /^PO-/ })).toHaveCount(1);
  const existing = await purchases.getByRole('link', { name: /^PO-/ }).innerText();
  await purchases.getByRole('button', { name: /生成采购单/ }).click();
  const form = page.getByRole('dialog', { name: '新建采购单' });
  await expect(form).toContainText('将复制销售订单');
  await selectOption(page, form, '供应商', VENDOR);
  await form.getByLabel('主题').fill('E2E 以销定采');
  await form.getByRole('button', { name: SAVE }).click();
  await expect(form).toBeHidden();
  await expect(purchases.getByRole('link', { name: /^PO-/ })).toHaveCount(2);
  // 列表按创建时间倒序，取新增的那一张 / the list is newest first; take the new one
  const numbers = await purchases.getByRole('link', { name: /^PO-/ }).allInnerTexts();
  const poNumber = numbers.find((x) => x !== existing)!;
  await closeDrawer(page, order);

  // 填写单价、下单 / fill in costs and place the order
  await nav(page, '采购单');
  await page.getByRole('button', { name: poNumber }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(`采购单详情 · ${poNumber}`) });
  const actions = drawer.getByTestId('po-actions');
  await expect(drawer.getByTestId('po-detail')).toContainText('草稿');
  await actions.getByRole('button', { name: /下\s*单/ }).click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByText(/采购单价未填写，不能下单/)).toBeVisible();
  await actions.getByRole('button', { name: /编\s*辑/ }).click();
  const edit = page.getByRole('dialog', { name: '编辑采购单' });
  const costs = edit.getByLabel(/^采购单价 \d+$/);
  const n = await costs.count();
  for (let i = 0; i < n; i++) await costs.nth(i).fill('100');
  await edit.getByRole('button', { name: SAVE }).click();
  await expect(edit).toBeHidden();
  await actions.getByRole('button', { name: /下\s*单/ }).click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(drawer.getByTestId('po-detail')).toContainText('已下单');
  await expect(drawer.getByTestId('po-detail')).toContainText('（下单日）');

  // 分批收货 / receive in batches
  await actions.getByRole('button', { name: /收\s*货/ }).click();
  let modal = page.getByRole('dialog', { name: '收货' });
  const first = modal.getByLabel(/^本次收货 /).first();
  await first.fill('1');
  // 其余行本次不收 / receive nothing on other lines this time
  const inputs = modal.getByLabel(/^本次收货 /);
  for (let i = 1; i < (await inputs.count()); i++) await inputs.nth(i).fill('0');
  await modal.getByRole('button', { name: '确认收货' }).click();
  await expect(modal).toBeHidden();
  await expect(drawer.getByTestId('po-detail')).toContainText('部分到货');
  await actions.getByRole('button', { name: /收\s*货/ }).click();
  modal = page.getByRole('dialog', { name: '收货' });
  await modal.getByRole('button', { name: '确认收货' }).click();
  await expect(modal).toBeHidden();
  await expect(drawer.getByTestId('po-detail')).toContainText('已到货');
  await expect(actions.getByRole('button', { name: /收\s*货/ })).toHaveCount(0);
  await expect(actions.getByRole('link', { name: /打印/ })).toHaveAttribute('href', /\/print\/purchase-order\?id=/);
});

test('只读用户只能查看采购；销售代表看不到采购菜单 / read-only and sales', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '采购单');
  await expect(page.getByRole('button', { name: '新建采购单' })).toHaveCount(0);
  await page.getByRole('button', { name: /^PO-\d{4}-0002$/ }).click();
  const drawer = page.getByRole('dialog', { name: /采购单详情/ });
  await expect(drawer.getByTestId('po-detail')).toContainText('部分到货');
  await expect(drawer.getByTestId('po-actions').getByRole('button', { name: /收\s*货|编\s*辑|下\s*单/ })).toHaveCount(0);
  await closeDrawer(page, drawer);

  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await demoSignIn(page, '王芳');
  await expect(sideMenu(page).getByRole('link', { name: '采购单', exact: true })).toHaveCount(0);
  await expect(sideMenu(page).getByRole('link', { name: '供应商', exact: true })).toHaveCount(0);
});
