/**
 * 回收站 第三轮：端到端回归（删除提示移入回收站 → 回收站查看 → 恢复并跳转查看 → 依赖缺失提示 → 彻底删除与清空；
 * 经理无彻底删除，销售代表无回收站入口）。
 * Recycle bin round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList, signIn } from './helpers';

/** 用当前登录令牌调用 API / call the API with the current session */
async function api(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.status() === 204 ? null : res.json();
}

/** 演示账号一键登录 / one-click demo login */
async function demoLogin(page: Page, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

const confirmPopover = (page: Page) => page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ });

test('删除、恢复、依赖提示、彻底删除与清空 / delete, restore, dependency hint, purge and empty', async ({ page }) => {
  await signIn(page);
  const lead = await api(page, 'POST', '/api/leads', { name: 'E2E 回收线索' });
  await api(page, 'POST', '/api/notes', { leadId: lead.id, content: '回收前的备注' });

  // 删除：提示移入回收站 / delete moves to the bin
  await nav(page, '线索');
  await searchList(page, '搜索姓名、公司、邮箱、电话', 'E2E 回收线索');
  const row = page.getByRole('row', { name: /E2E 回收线索/ });
  await row.getByRole('button', { name: /删\s*除/ }).click();
  await expect(page.locator('.ant-popover:visible')).toContainText('记录将移入回收站，30 天内可恢复');
  await confirmPopover(page).click();
  await expect(page.getByText('已移入回收站，30 天内可恢复').first()).toBeVisible();
  await expect(row).toHaveCount(0);

  // 回收站：查看并恢复，跳转查看 / restore and open
  await nav(page, '回收站');
  const entry = page.getByRole('row', { name: /E2E 回收线索/ });
  await expect(entry).toContainText('线索');
  await expect(entry).toContainText('备注 1');
  await expect(entry).toContainText('30 天');
  await entry.getByRole('button', { name: /恢\s*复/ }).click();
  const note = page.locator('.ant-notification-notice').filter({ hasText: '已恢复：E2E 回收线索' });
  await expect(note).toBeVisible();
  await expect(entry).toHaveCount(0);
  await note.getByRole('link', { name: '查看' }).click();
  await expect(page).toHaveURL(/\/leads/);
  const drawer = page.getByRole('dialog', { name: /线索详情/ });
  await expect(drawer).toContainText('E2E 回收线索');
  await expect(drawer).toContainText('回收前的备注');
  await closeDrawer(page, drawer);

  // 依赖缺失：先删商机再删客户，恢复商机提示先恢复客户 / missing account hint
  const acc = await api(page, 'POST', '/api/accounts', { name: 'E2E 回收客户' });
  const deal = await api(page, 'POST', '/api/deals', { name: 'E2E 回收商机', accountId: acc.id });
  await api(page, 'DELETE', `/api/deals/${deal.id}`);
  await api(page, 'DELETE', `/api/accounts/${acc.id}`);
  await nav(page, '回收站');
  await page.locator('.ant-segmented').getByText('商机', { exact: true }).click();
  const dealRow = page.getByRole('row', { name: /E2E 回收商机/ });
  await dealRow.getByRole('button', { name: /恢\s*复/ }).click();
  await expect(page.getByText('所属客户已不存在，请先恢复客户').first()).toBeVisible();
  await expect(dealRow).toBeVisible();

  // 彻底删除单条 / purge one
  await dealRow.getByRole('button', { name: '彻底删除' }).click();
  await expect(page.locator('.ant-popover:visible')).toContainText('彻底删除“E2E 回收商机”？此操作不可恢复。');
  await confirmPopover(page).click();
  await expect(dealRow).toHaveCount(0);

  // 清空 / empty
  await page.locator('.ant-segmented').getByText('全部', { exact: true }).click();
  await expect(page.getByRole('row', { name: /E2E 回收客户/ })).toBeVisible();
  await page.getByRole('button', { name: '清空回收站' }).click();
  await confirmPopover(page).click();
  await expect(page.getByRole('row', { name: /E2E 回收客户/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '清空回收站' })).toBeDisabled();

  // 审计 / audit
  await nav(page, '审计日志');
  await expect(page.locator('.ant-table:visible').first()).toContainText('从回收站恢复');
});

test('经理可恢复但不能彻底删除 / managers cannot purge', async ({ page }) => {
  await demoLogin(page, '郑经理');
  await nav(page, '回收站');
  await expect(page.getByText('删除的线索、客户、商机保留 30 天')).toBeVisible();
  await expect(page.getByRole('button', { name: '清空回收站' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '彻底删除' })).toHaveCount(0);
});

test('销售代表没有回收站入口 / sales reps have no recycle bin', async ({ page }) => {
  await demoLogin(page, '王芳');
  await expect(page.getByRole('menu').getByRole('link', { name: '回收站' })).toHaveCount(0);
  await page.goto('/recycle-bin');
  await expect(page.getByText('没有权限执行该操作').first()).toBeVisible();
});
