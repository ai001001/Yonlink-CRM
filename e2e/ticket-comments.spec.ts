/**
 * 工单评论 第三轮：端到端回归（经理在王芳负责的演示工单上发表内部备注 → 王芳在通知中心看到并打开工单 → 查看往来、
 * 发表对外回复、修改、删除自己的评论；只读用户能看到评论但没有发表框）。
 * Ticket comments round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, searchList } from './helpers';

const SUBJECT = /涡轮增压器异响/;

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 打开演示工单 / open the demo ticket */
async function openTicket(page: Page) {
  await nav(page, '服务工单');
  await searchList(page, '搜索工单号、主题、客户、联系人', '异响');
  await page.getByRole('row', { name: SUBJECT }).getByRole('button', { name: SUBJECT }).click();
  const drawer = page.getByRole('dialog', { name: /工单详情/ });
  await expect(drawer.getByTestId('ticket-comments')).toBeVisible();
  return drawer;
}

test.describe.serial('工单评论往来 / ticket comments', () => {
  test('经理发表内部备注 / manager posts an internal note', async ({ page }) => {
    await demoSignIn(page, '郑经理');
    const drawer = await openTicket(page);
    const thread = drawer.getByTestId('ticket-comments');
    // 演示往来 2 条 / two demo comments
    await expect(thread.getByTestId('ticket-comment')).toHaveCount(2);
    const form = drawer.getByTestId('ticket-comment-form');
    await form.getByRole('radio', { name: '内部备注' }).check();
    await expect(form.getByRole('button', { name: /发\s*表/ })).toBeDisabled();
    await form.getByLabel('处理记录').fill('E2E 经理：周三前安排上门');
    await form.getByRole('button', { name: /发\s*表/ }).click();
    const mine = thread.getByTestId('ticket-comment').filter({ hasText: 'E2E 经理：周三前安排上门' });
    await expect(mine).toContainText('内部备注');
    await expect(mine).toContainText('郑经理');
    await expect(form.getByLabel('处理记录')).toHaveValue('');
  });

  test('负责人收到通知并回复、修改、删除 / owner is notified and replies', async ({ page }) => {
    await demoSignIn(page, '王芳');
    // 通知中心从顶部铃铛进入 / the notification centre is opened from the bell
    await page.getByTestId('notification-bell').click();
    await page.getByTestId('notification-popover').getByRole('link', { name: '查看全部通知' }).click();
    await expect(page).toHaveURL(/\/notifications\/?$/);
    // 只在页面主体中查找：铃铛弹窗关闭动画期间其中的同名链接仍在页面上 / search the page body only: the bell popover still holds the same link while it fades out
    const note = page.getByRole('main').getByRole('link', { name: /郑经理 评论了工单 CS-\d{4}-\d{4} 【演示】涡轮增压器异响/ });
    await expect(note).toBeVisible();
    await note.click();
    const drawer = page.getByRole('dialog', { name: /工单详情/ });
    const thread = drawer.getByTestId('ticket-comments');
    await expect(thread).toContainText('E2E 经理：周三前安排上门');
    // 经理的评论王芳不能修改或删除 / Wang Fang cannot edit or delete the manager's comment
    const managers = thread.getByTestId('ticket-comment').filter({ hasText: 'E2E 经理' });
    await expect(managers.getByRole('button')).toHaveCount(0);

    const form = drawer.getByTestId('ticket-comment-form');
    await form.getByLabel('处理记录').fill('E2E 已与客户约定周三上午上门');
    await form.getByRole('button', { name: /发\s*表/ }).click();
    const reply = thread.getByTestId('ticket-comment').filter({ hasText: 'E2E 已与客户约定' });
    await expect(reply).toContainText('对外回复');
    await reply.getByRole('button', { name: /编\s*辑/ }).click();
    await reply.getByLabel('评论内容').fill('E2E 已与客户约定周三下午上门');
    await reply.getByRole('button', { name: /保\s*存/ }).click();
    await expect(reply).toContainText('周三下午上门');
    await expect(reply).toContainText('已编辑');
    await reply.getByRole('button', { name: /删\s*除/ }).click();
    await page.locator('.ant-popover:visible').getByRole('button', { name: /确\s*定|OK/ }).click();
    await expect(thread.getByTestId('ticket-comment').filter({ hasText: 'E2E 已与客户约定' })).toHaveCount(0);
  });

  test('只读用户能看评论但不能发表 / read-only users view only', async ({ page }) => {
    await demoSignIn(page, '周会计');
    const drawer = await openTicket(page);
    await expect(drawer.getByTestId('ticket-comments')).toContainText('E2E 经理：周三前安排上门');
    await expect(drawer.getByTestId('ticket-comment-form')).toHaveCount(0);
  });
});
