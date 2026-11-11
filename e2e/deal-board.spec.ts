/**
 * 商机看板 第三轮：端到端回归（切换看板 → 拖动卡片改阶段 → “移动到”改阶段 → 刷新后保持 → 列表一致 → 只读用户不可拖动）。
 * Deal board round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { demoSamples } from '../prisma/demo-data';
import { nav, signIn } from './helpers';

const S = demoSamples();

/** 用当前登录令牌经 API 准备数据 / seed data through the API with the current token */
async function seedDeal(page: Page, name: string, amount: string) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const headers = { Authorization: `Bearer ${token}` };
  const acc = await (await page.request.post('/api/accounts', { headers, data: { name: `${name} 客户` } })).json();
  const res = await page.request.post('/api/deals', { headers, data: { name, accountId: acc.id, amount } });
  expect(res.status()).toBe(201);
}

test('商机看板拖动与移动 / deal board drag and move', async ({ page }) => {
  await signIn(page);
  await seedDeal(page, 'E2E 看板商机甲', '12000');
  await seedDeal(page, 'E2E 看板商机乙', '3000');

  await nav(page, '商机');
  await page.getByText('看板', { exact: true }).click();
  await expect(page.getByText('拖动卡片到其他阶段即可更新销售阶段')).toBeVisible();
  const qualification = page.getByTestId('board-col-QUALIFICATION');
  const proposal = page.getByTestId('board-col-PROPOSAL');
  const negotiation = page.getByTestId('board-col-NEGOTIATION');
  await expect(qualification.getByLabel('E2E 看板商机甲', { exact: true })).toBeVisible();

  // 只看本用例数据 / narrow the board to this test's data
  await page.getByPlaceholder('搜索商机名称、客户名称').fill('E2E 看板商机');
  await page.getByPlaceholder('搜索商机名称、客户名称').press('Enter');
  await expect(qualification.getByTestId('board-col-count')).toHaveText('2');
  await expect(qualification.getByTestId('board-col-sum')).toContainText('¥15,000.00');

  // 拖动卡片到“方案报价” / drag a card to PROPOSAL
  await qualification.getByLabel('E2E 看板商机甲', { exact: true }).dragTo(proposal);
  await expect(page.getByText('已移动到“方案报价”').first()).toBeVisible();
  await expect(proposal.getByLabel('E2E 看板商机甲', { exact: true })).toBeVisible();
  await expect(proposal.getByTestId('board-col-sum')).toContainText('¥12,000.00');
  await expect(qualification.getByTestId('board-col-count')).toHaveText('1');

  // 用“移动到”把另一张卡片移到“商务谈判”（无需鼠标拖动）/ use the Move-to select
  await qualification.getByLabel('移动到 E2E 看板商机乙').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('商务谈判', { exact: true }).click();
  await expect(negotiation.getByLabel('E2E 看板商机乙', { exact: true })).toBeVisible();

  // 刷新后保持，列表视图一致 / persisted after reload and consistent with the list
  await page.reload();
  await page.getByText('看板', { exact: true }).click();
  await page.getByPlaceholder('搜索商机名称、客户名称').fill('E2E 看板商机');
  await page.getByPlaceholder('搜索商机名称、客户名称').press('Enter');
  await expect(page.getByTestId('board-col-PROPOSAL').getByLabel('E2E 看板商机甲', { exact: true })).toBeVisible();
  await expect(page.getByTestId('board-col-NEGOTIATION').getByLabel('E2E 看板商机乙', { exact: true })).toBeVisible();
  await page.getByText('列表', { exact: true }).click();
  await expect(page.getByRole('row', { name: /E2E 看板商机甲/ })).toContainText('方案报价');
  await expect(page.getByRole('row', { name: /E2E 看板商机乙/ })).toContainText('商务谈判');

  // 点击卡片打开详情，操作记录中有阶段变更 / card opens the detail with the stage change in its log
  await page.getByText('看板', { exact: true }).click();
  await page.getByTestId('board-col-PROPOSAL').getByRole('button', { name: 'E2E 看板商机甲' }).click();
  const drawer = page.getByRole('dialog', { name: /商机详情 · E2E 看板商机甲/ });
  await drawer.getByRole('tab', { name: '操作记录' }).click();
  await expect(drawer.getByTestId('audit-trail')).toContainText('销售阶段：资格确认 → 方案报价');
});

test('只读用户看板不可拖动、无“移动到” / read-only users cannot move cards', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '商机');
  await page.getByText('看板', { exact: true }).click();
  const card = page.getByLabel(S.sales1Deal, { exact: true });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('draggable', 'false');
  await expect(page.getByLabel(`移动到 ${S.sales1Deal}`)).toHaveCount(0);
});
