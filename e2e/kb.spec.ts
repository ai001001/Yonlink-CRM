/**
 * 知识库 第三轮：端到端回归（销售王芳写草稿、不能发布 → 经理郑经理在草稿中发布 → 王芳在自己的工单中关联该文章并跳转到
 * 文章、浏览数增加、文章列出引用工单；只读用户只能看已发布文章）。基于演示数据。
 * Knowledge base round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList } from './helpers';

const TITLE = 'E2E 增压器冷启动异响处理';
const SAVE = /保\s*存/;

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test.describe.serial('知识库 / knowledge base', () => {
  test('销售写草稿，不能发布 / a rep writes a draft', async ({ page }) => {
    await demoSignIn(page, '王芳');
    await nav(page, '知识库');
    await expect(page.getByRole('row', { name: /涡轮增压器异响排查步骤/ })).toBeVisible();
    await page.getByRole('button', { name: '写文章' }).click();
    const form = page.getByRole('dialog', { name: '写文章' });
    await expect(form).toContainText('新文章保存为草稿');
    await form.getByLabel('标题').fill(TITLE);
    await form.getByLabel('分类').fill('故障排查');
    await form.getByLabel('正文').fill('1. 冷车启动后观察 30 秒。\n2. <b>不是 HTML</b>，按原文显示。');
    await form.getByRole('button', { name: SAVE }).click();
    await expect(form).toBeHidden();
    const drawer = page.getByRole('dialog', { name: TITLE });
    await expect(drawer.getByTestId('kb-detail')).toContainText('草稿');
    // 正文按纯文本显示 / the body is shown as plain text
    await expect(drawer.getByTestId('kb-body')).toContainText('<b>不是 HTML</b>，按原文显示。');
    await expect(drawer.getByTestId('kb-body').locator('b')).toHaveCount(0);
    await expect(drawer.getByTestId('kb-actions').getByRole('button', { name: /发\s*布/ })).toHaveCount(0);
    await expect(drawer.getByTestId('kb-actions').getByRole('button', { name: /编\s*辑/ })).toBeVisible();
  });

  test('经理发布草稿 / the manager publishes it', async ({ page }) => {
    await demoSignIn(page, '郑经理');
    await nav(page, '知识库');
    await page.getByText('草稿', { exact: true }).click();
    const row = page.getByRole('row', { name: new RegExp(TITLE) });
    await expect(row).toContainText('王芳');
    await row.getByRole('button', { name: TITLE }).click();
    const drawer = page.getByRole('dialog', { name: TITLE });
    await drawer.getByTestId('kb-actions').getByRole('button', { name: /发\s*布/ }).click();
    await expect(drawer.getByTestId('kb-detail')).toContainText('已发布');
    await closeDrawer(page, drawer);
    await page.getByText('已发布', { exact: true }).click();
    await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toBeVisible();
  });

  test('销售在工单中关联并打开文章 / the rep links it on a ticket', async ({ page }) => {
    await demoSignIn(page, '王芳');
    await nav(page, '服务工单');
    await searchList(page, '搜索工单号、主题、客户、联系人', '异响');
    await page.getByRole('row', { name: /涡轮增压器异响/ }).getByRole('button', { name: /涡轮增压器异响/ }).click();
    const drawer = page.getByRole('dialog', { name: /工单详情/ });
    const section = drawer.getByTestId('ticket-articles');
    // 演示数据已关联排查步骤 / the demo already links the troubleshooting article
    await expect(section).toContainText('涡轮增压器异响排查步骤');
    const picker = section.getByLabel('搜索并关联已发布的文章');
    const option = page.locator('.ant-select-dropdown:visible').getByTitle(TITLE, { exact: true });
    await expect(async () => {
      if (!(await option.isVisible())) {
        await picker.click({ timeout: 2000 });
        await picker.fill('冷启动', { timeout: 2000 });
      }
      await option.click({ timeout: 2000 });
      await expect(section.getByRole('link', { name: TITLE })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
    await section.getByRole('link', { name: TITLE }).click();
    const article = page.getByRole('dialog', { name: TITLE });
    await expect(article.getByTestId('kb-views')).toHaveText('1');
    await expect(article.getByTestId('kb-detail')).toContainText('涡轮增压器异响，怠速时明显');
  });

  test('只读用户只能看已发布文章 / read-only users', async ({ page }) => {
    await demoSignIn(page, '周会计');
    await nav(page, '知识库');
    await expect(page.getByRole('button', { name: '写文章' })).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toBeVisible();
    await page.getByText('草稿', { exact: true }).click();
    await expect(page.getByRole('row', { name: /双语安装手册整理计划/ })).toHaveCount(0);
    // 表格为空（空表时 antd 不显示分页总数）/ empty table (antd hides the pagination total when empty)
    await expect(page.locator('.ant-table-tbody .ant-empty-description')).toHaveText('暂无数据');
  });
});
