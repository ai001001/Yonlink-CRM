/**
 * 网页表单 第三轮：端到端回归（经理：查看演示表单 → 新建表单（加手机字段、邮箱必填、分配给王芳）→ 访客在未登录的浏览器中打开
 * 公开地址，必填校验后提交成功 → 表单详情的提交次数与最近线索 → 线索详情显示来源表单 → 王芳的通知中心收到表单线索 →
 * 重新生成地址后旧地址失效；只读用户只能查看）。基于演示数据。
 * Web forms round 3: end-to-end regression on the demo data.
 */
import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, nav, searchList, selectOption } from './helpers';

const SAVE = /保\s*存/;
const FORM = 'E2E 官网报价表单';
const VISITOR = 'E2E 访客李雷';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

test('经理：网页表单从创建到收到线索 / manager: web form to lead', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');

  // 列表：演示表单，默认只显示启用 / list shows the active demo forms
  await nav(page, '网页表单');
  await expect(page.getByRole('row', { name: /官网产品咨询/ })).toContainText('3');
  await expect(page.getByRole('row', { name: /技术研讨会报名/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /现场登记/ })).toHaveCount(0);

  // 新建：加手机字段、邮箱必填、分配给王芳 / create: add mobile, require email, assign to 王芳
  await page.getByRole('button', { name: '新建网页表单' }).click();
  const dialog = page.getByRole('dialog', { name: '新建网页表单' });
  await dialog.getByLabel('表单名称').fill(FORM);
  await dialog.getByLabel('表单标题').fill('E2E 获取报价');
  await dialog.locator('#webform_fields').getByLabel('手机').check();
  await expect(dialog.locator('#webform_requiredFields').getByLabel('邮箱')).toBeChecked();
  await selectOption(page, dialog, '线索负责人', '王芳');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(dialog).toBeHidden();

  // 详情：公开地址 / detail: public URL
  const drawer = page.getByRole('dialog', { name: `网页表单详情 · ${FORM}` });
  const url = await drawer.getByTestId('webform-url').inputValue();
  expect(url).toMatch(/\/web-form\/?\?key=/);
  await expect(drawer.getByTestId('webform-leads')).toContainText('还没有收到提交');

  // 访客在未登录的浏览器中提交 / a visitor submits from a signed-out browser
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(url);
  const card = visitor.getByTestId('public-web-form');
  await expect(card.getByRole('heading', { name: 'E2E 获取报价' })).toBeVisible();
  for (const label of ['姓名', '公司', '邮箱', '电话', '手机', '留言']) await expect(card.getByLabel(label, { exact: true })).toBeVisible();
  await card.getByLabel('姓名', { exact: true }).fill(VISITOR);
  await card.getByRole('button', { name: /提\s*交/ }).click();
  await expect(card.getByText('请填写邮箱')).toBeVisible();
  await card.getByLabel('邮箱', { exact: true }).fill('lilei@example.com');
  await card.getByLabel('公司', { exact: true }).fill('E2E 访客公司');
  await card.getByLabel('留言', { exact: true }).fill('想了解 13L 增压器报价');
  await card.getByRole('button', { name: /提\s*交/ }).click();
  await expect(visitor.getByTestId('web-form-success')).toContainText('提交成功，我们会尽快与您联系。');

  // 表单详情：提交次数与最近线索 / the detail shows the count and the lead
  await closeDrawer(page, drawer);
  await searchList(page, '搜索表单名称、标题', FORM);
  await expect(page.getByRole('row', { name: new RegExp(FORM) })).toContainText('1');
  await page.getByRole('button', { name: FORM, exact: true }).click();
  await expect(drawer.getByTestId('webform-leads')).toContainText(VISITOR);
  await expect(drawer.getByTestId('webform-leads')).toContainText('E2E 访客公司');

  // 线索详情显示来源表单 / the lead detail shows the source form
  await drawer.getByRole('link', { name: VISITOR }).click();
  await expect(page.getByTestId('lead-web-form')).toHaveText(FORM);

  // 重新生成地址：旧地址失效 / regenerate: the old URL stops working
  await page.goto('/web-forms');
  await searchList(page, '搜索表单名称、标题', FORM);
  await page.getByRole('button', { name: FORM, exact: true }).click();
  await drawer.getByRole('button', { name: '重新生成地址' }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(drawer.getByTestId('webform-url')).not.toHaveValue(url);
  await visitor.goto(url);
  await expect(visitor.getByText('表单不存在或已停用')).toBeVisible();
  await visitorContext.close();

  // 王芳的通知中心收到表单线索（新的浏览器上下文：已登录时打开登录页会跳回首页）
  // 王芳 is notified (a fresh context: the login page redirects signed-in users home)
  const repContext = await browser.newContext();
  const rep = await repContext.newPage();
  await demoSignIn(rep, '王芳');
  await rep.goto('/notifications');
  await expect(rep.getByText(`网页表单收到新线索：${VISITOR} · ${FORM}`)).toBeVisible();
  await repContext.close();
});

test('只读用户只能查看网页表单 / read-only users only view web forms', async ({ page }) => {
  await demoSignIn(page, '周会计');
  await nav(page, '网页表单');
  await expect(page.getByRole('button', { name: '新建网页表单' })).toHaveCount(0);
  await page.getByRole('button', { name: '【演示】官网产品咨询', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /网页表单详情 · 【演示】官网产品咨询/ });
  await expect(drawer.getByTestId('webform-url')).toHaveValue(/\/web-form\/?\?key=/);
  await expect(drawer.getByTestId('webform-leads').locator('tbody tr')).toHaveCount(3);
  await expect(drawer.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '重新生成地址' })).toHaveCount(0);
  await closeDrawer(page, drawer);
});
