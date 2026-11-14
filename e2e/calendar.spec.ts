/**
 * 跟进日历 第三轮：端到端回归（切换日历 → 查看 → 标记完成 → 拖动改期 → 在某天新建 → 周视图与翻页 → 类型筛选；只读用户不可拖动）。
 * Activity calendar round 3: end-to-end regression.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, signIn } from './helpers';

// 固定北京时间，日期计算稳定 / fixed time zone for stable dates
test.use({ timezoneId: 'Asia/Shanghai' });

/** 北京时间的日期（偏移天数）/ a Beijing date with an offset in days */
function shanghaiDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

/** 用当前登录令牌调用 API / call the API with the current session */
async function apiCall(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('日历查看、完成、拖动改期、在某天新建 / calendar view, complete, drag, create on a day', async ({ page }) => {
  const today = shanghaiDate();
  const tomorrow = shanghaiDate(1);
  await signIn(page);
  const act = await apiCall(page, 'POST', '/api/activities', { type: 'VISIT', subject: 'E2E 日历拜访', dueAt: `${today}T10:30:00+08:00` });

  await nav(page, '跟进');
  await page.getByText('日历', { exact: true }).click();
  const cal = page.getByTestId('activity-calendar');
  await expect(cal).toContainText('没有截止时间的跟进只在列表中显示');
  const todayCell = cal.locator(`[data-testid="calendar-day"][data-date="${today}"]`);
  const chip = todayCell.getByTestId('calendar-item').filter({ hasText: 'E2E 日历拜访' });
  await expect(chip).toContainText('10:30');

  // 点击查看并标记完成 / open and mark done
  await chip.click();
  const drawer = page.getByRole('dialog', { name: 'E2E 日历拜访' });
  await drawer.getByRole('button', { name: '标记完成' }).click();
  await expect(drawer.getByRole('button', { name: '重新打开' })).toBeVisible();
  await expect(drawer).toContainText('已完成');
  await closeDrawer(page, drawer);
  await expect(drawer).toBeHidden();
  // 点日期数字区域选中当天（点中心可能落在跟进条目上）/ click the date corner, the centre may hit an item
  await todayCell.click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('calendar-agenda').getByRole('listitem').filter({ hasText: 'E2E 日历拜访' })).toContainText('已完成');

  // 拖到明天：保留 10:30 / drag to tomorrow keeping 10:30
  const tomorrowCell = cal.locator(`[data-testid="calendar-day"][data-date="${tomorrow}"]`);
  await chip.dragTo(tomorrowCell);
  await expect(page.getByText(`已改到 ${tomorrow}`).first()).toBeVisible();
  await expect(tomorrowCell.getByTestId('calendar-item').filter({ hasText: 'E2E 日历拜访' })).toContainText('10:30');
  await expect(todayCell.getByTestId('calendar-item').filter({ hasText: 'E2E 日历拜访' })).toHaveCount(0);
  const moved = await apiCall(page, 'GET', `/api/activities/${act.id}`);
  expect(moved.dueAt).toBe(new Date(`${tomorrow}T10:30:00+08:00`).toISOString());

  // 在明天新建：截止时间默认 09:00 / create on tomorrow, due 09:00 by default
  await tomorrowCell.click({ position: { x: 8, y: 8 } });
  const agenda = page.getByTestId('calendar-agenda');
  await expect(agenda).toContainText(`${tomorrow} 的跟进`);
  await agenda.getByRole('button', { name: '在这一天新建' }).click();
  const dialog = page.getByRole('dialog', { name: '新增跟进' });
  await expect(dialog.getByLabel('截止/计划时间')).toHaveValue(`${tomorrow} 09:00`);
  await dialog.getByLabel('主题').fill('E2E 日历新建任务');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  await expect(tomorrowCell.getByTestId('calendar-item').filter({ hasText: 'E2E 日历新建任务' })).toContainText('09:00');

  // 类型筛选：只看客户拜访 / type filter
  await cal.getByLabel('类型').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('客户拜访', { exact: true }).click();
  await expect(tomorrowCell.getByTestId('calendar-item').filter({ hasText: 'E2E 日历拜访' })).toBeVisible();
  await expect(tomorrowCell.getByTestId('calendar-item').filter({ hasText: 'E2E 日历新建任务' })).toHaveCount(0);

  // 周视图与翻页 / week view and paging
  await cal.getByText('周', { exact: true }).click();
  await expect(cal.getByTestId('calendar-day')).toHaveCount(7);
  const title = cal.getByTestId('calendar-title');
  const before = await title.textContent();
  await cal.getByRole('button', { name: '下一页' }).click();
  await expect(title).not.toHaveText(before ?? '');
  await cal.getByRole('button', { name: /今\s*天/ }).click();
  await expect(title).toHaveText(before ?? '');
  await expect(cal.locator(`[data-testid="calendar-day"][data-date="${today}"]`)).toBeVisible();
});

test('只读用户：可查看日历，不能拖动或新建 / read-only user cannot drag or create', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: '登录 周会计' }).click();
  await expect(page.getByTestId('current-role')).toHaveText('只读用户');
  await nav(page, '跟进');
  await page.getByText('日历', { exact: true }).click();
  const items = page.getByTestId('calendar-item');
  await expect(items.first()).toBeVisible();
  await expect(items.first()).toHaveAttribute('draggable', 'false');
  await expect(page.getByRole('button', { name: '在这一天新建' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新增跟进' })).toHaveCount(0);
});
