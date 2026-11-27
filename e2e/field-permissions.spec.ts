/**
 * 字段权限 端到端（第一轮界面功能，第三轮回归）：管理员在“字段权限”页看到演示设置（只读用户的线索手机隐藏），
 * 把销售代表的线索“职位”设为只读、“邮箱”设为隐藏并保存；销售代表登录后，线索详情中没有邮箱、职位可见，
 * 编辑表单中职位不可修改、没有邮箱输入框，整页详情中职位没有编辑按钮、没有邮箱行。用例结束时恢复设置，不改演示数据。
 * Field permissions end to end: the admin restricts two lead fields for sales reps; the rep sees the effect in the
 * drawer, the edit form and the full page. The settings are restored afterwards.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav, selectOption } from './helpers';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 当前会话的令牌 / the current session token */
const tokenOf = (page: Page) => page.evaluate(() => localStorage.getItem('yonlink-crm.token'));

/** 用给定令牌调用接口 / call the API with a token */
async function api(page: Page, token: string | null, method: 'GET' | 'POST' | 'PUT', path: string, data?: object) {
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

test('管理员限制线索字段，销售代表在详情、表单与整页中看到效果 / admin restricts lead fields, the rep sees the effect', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await demoSignIn(page, '林管理');
  const admin = await tokenOf(page);
  try {
    await nav(page, '字段权限');
    const table = page.getByTestId('field-perm-table');
    // 演示设置：只读用户的线索手机隐藏 / demo settings: lead mobiles are hidden from read-only users
    await selectOption(page, page.getByRole('main'), '角色', '只读用户');
    await expect(page.getByTestId('field-perm-mobile').getByRole('radio', { name: '隐藏' })).toBeChecked();
    await expect(page.getByTestId('field-perm-email').getByRole('radio', { name: '可编辑' })).toBeChecked();

    // 销售代表：职位只读、邮箱隐藏 / sales reps: title read-only, email hidden
    await selectOption(page, page.getByRole('main'), '角色', '销售代表');
    await expect(table).toContainText('职位');
    await page.getByTestId('field-perm-title').getByText('只读', { exact: true }).click();
    await page.getByTestId('field-perm-email').getByText('隐藏', { exact: true }).click();
    await expect(page.getByText('有未保存的修改')).toBeVisible();
    await page.getByTestId('field-perm-save').click();
    await expect(page.getByText('保存成功')).toBeVisible();
    await expect(page.getByText('有未保存的修改')).toBeHidden();
    // 审计日志中有记录 / the change is audited
    const logs = await api(page, admin, 'GET', '/api/audit-logs?entityType=fieldpermission');
    expect(logs.items[0].changes.fields).toEqual({ title: ['EDIT', 'READ_ONLY'], email: ['EDIT', 'HIDDEN'] });

    // 管理员为王芳建一条线索 / the admin creates a lead for 王芳
    const users = await api(page, admin, 'GET', '/api/users');
    const rep = users.items.find((u: { name: string }) => u.name === '王芳');
    const lead = await api(page, admin, 'POST', '/api/leads', { name: 'E2E 字段权限线索', title: '采购总监', email: 'fp.e2e@example.com', ownerId: rep.id });

    // 销售代表在独立的浏览器上下文中登录（管理员会话保留，用于结束时恢复设置）/ the rep signs in in a separate context (the admin session stays for the restore)
    const repContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const repPage = await repContext.newPage();
    await demoSignIn(repPage, '王芳');
    await repPage.goto(`/leads?id=${lead.id}`);
    const drawer = repPage.getByRole('dialog', { name: /线索详情/ });
    await expect(drawer.getByText('采购总监')).toBeVisible();
    await expect(drawer.locator('.ant-descriptions-item-label').filter({ hasText: /^邮箱$/ })).toHaveCount(0);
    await expect(drawer.getByText('fp.e2e@example.com')).toHaveCount(0);
    // 编辑表单：职位不可修改，没有邮箱 / edit form: the title is disabled, no email
    await drawer.getByRole('button', { name: /编\s*辑/ }).first().click();
    const form = repPage.getByRole('dialog', { name: '编辑线索' });
    await expect(form.getByLabel('职位')).toBeDisabled();
    await expect(form.getByLabel('职位')).toHaveValue('采购总监');
    await expect(form.getByLabel('邮箱')).toHaveCount(0);
    await form.getByLabel('公司').fill('E2E 字段权限公司');
    await form.getByRole('button', { name: /保\s*存/ }).click();
    await expect(form).toBeHidden();
    await expect(drawer.getByText('E2E 字段权限公司')).toBeVisible();

    // 整页详情：职位没有编辑按钮，没有邮箱 / full page: no edit button on the title, no email
    await repPage.goto(`/leads/view?id=${lead.id}`);
    await expect(repPage.getByTestId('record-title')).toHaveText('E2E 字段权限线索');
    const titleRow = repPage.getByTestId('record-field').filter({ hasText: '职位' }).first();
    await expect(titleRow).toContainText('采购总监');
    await expect(titleRow.getByRole('button', { name: /编辑/ })).toHaveCount(0);
    await expect(repPage.getByTestId('record-field').filter({ hasText: '邮箱' })).toHaveCount(0);
    await expect(repPage.getByTestId('record-field').filter({ hasText: '公司' }).first().getByRole('button', { name: /编辑/ })).toHaveCount(1);
    await repContext.close();
  } finally {
    // 恢复销售代表的线索设置 / restore the sales reps' lead settings
    await api(page, admin, 'PUT', '/api/field-permissions', { entity: 'LEAD', role: 'SALES', rules: {} });
  }
});
