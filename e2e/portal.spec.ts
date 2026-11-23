/**
 * 客户门户 第三轮：端到端回归（经理：设置 › 客户门户看到已启用与登录地址 → 在联系人详情中开通门户，得到邀请链接；
 * 客户：打开邀请链接设置密码 → 门户首页 → 提交工单 → 工单详情回复 → 退出并用密码重新登录；员工看到门户工单与客户回复）。
 * 只操作本用例新建的联系人与工单，结束时停用该联系人的门户。
 * Customer portal round 3: end-to-end regression; only touches the contact and tickets it creates and disables the
 * contact's portal access afterwards.
 */
import { expect, test, type Page } from '@playwright/test';
import { nav } from './helpers';

const PW = 'E2E-portal-pass-1';

/** 演示账号登录 / demo sign-in */
async function demoSignIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByTestId('demo-accounts').getByRole('button', { name: `登录 ${name}` }).click();
  await expect(page.getByTestId('user-menu')).toContainText(name);
}

/** 以员工会话调用接口 / call the API with the staff session */
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const token = await page.evaluate(() => localStorage.getItem('yonlink-crm.token'));
  const res = await page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok(), `${method} ${path}`).toBe(true);
  return res.json();
}

test('开通门户，客户设置密码、提交与回复工单、重新登录 / portal end to end', async ({ page }) => {
  test.setTimeout(150_000);
  await demoSignIn(page, '郑经理');
  await nav(page, '客户门户');
  await expect(page.getByRole('switch', { name: '启用客户门户' })).toBeChecked();
  await expect(page.getByTestId('portal-url')).toHaveValue(/\/portal\/login\/?\?k=/);

  const account = (await api(page, 'GET', '/api/accounts?pageSize=1')).items[0];
  const email = `e2e-portal-${Date.now()}@example.com`;
  const contact = await api(page, 'POST', `/api/accounts/${account.id}/contacts`, { name: 'E2E 门户客户', email });
  try {
    await page.goto(`/contacts?id=${contact.id}`);
    const section = page.getByTestId('contact-portal');
    await expect(section).toContainText('未开通');
    await section.getByTestId('portal-invite').click();
    const link = await page.getByTestId('portal-invite-link').inputValue();
    expect(link).toMatch(/\/portal\/accept\/?\?token=/);
    await page.getByRole('dialog', { name: '门户邀请链接' }).locator('.ant-modal-footer').getByRole('button', { name: /关\s*闭/ }).click();
    await expect(section).toContainText('待接受邀请');

    // 客户：设置密码 / customer: set the password
    await page.goto(link);
    await page.getByLabel('新密码').fill(PW);
    await page.getByLabel('确认密码').fill(PW);
    await page.getByRole('button', { name: '设置密码并登录' }).click();
    await expect(page.getByTestId('portal-user')).toContainText('E2E 门户客户，您好');
    await expect(page.getByText('【演示】欢迎使用演示客户服务门户')).toBeVisible();

    // 提交工单 / raise a ticket
    await page.getByTestId('portal-new-ticket').click();
    const dialog = page.getByRole('dialog', { name: '提交新工单' });
    await dialog.getByLabel('主题').fill('E2E 门户工单：增压器漏油');
    await dialog.getByLabel('问题描述').fill('安装两周后出现漏油');
    await dialog.getByRole('button', { name: /提\s*交/ }).click();
    await expect(page.locator('.ant-message')).toContainText('已提交工单');
    await page.getByTestId('portal-ticket-link').filter({ hasText: 'E2E 门户工单：增压器漏油' }).click();
    await expect(page.getByTestId('portal-ticket-status')).toHaveText('新建');
    await page.getByLabel('回复').fill('补充：漏油位置在进油口');
    await page.getByRole('button', { name: /回\s*复/ }).click();
    await expect(page.getByTestId('portal-comments')).toContainText('补充：漏油位置在进油口');
    await expect(page.getByTestId('portal-comments')).toContainText('我');

    // 退出并重新登录 / sign out and back in
    await page.getByRole('button', { name: /退\s*出/ }).click();
    await expect(page.getByText('登录客户门户')).toBeVisible();
    await page.getByLabel('邮箱').fill(email);
    await page.getByLabel('密码').fill(PW);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page.getByTestId('portal-user')).toContainText('E2E 门户客户');
    await expect(page.getByTestId('portal-ticket-link').filter({ hasText: 'E2E 门户工单：增压器漏油' })).toBeVisible();

    // 员工：看到门户工单与客户回复（员工会话不受门户登录影响）/ staff see the portal ticket and the reply
    const staff = await api(page, 'GET', `/api/tickets?q=${encodeURIComponent('E2E 门户工单')}`);
    expect(staff.items[0]).toMatchObject({ channel: 'PORTAL', contactId: contact.id });
    const comments = await api(page, 'GET', `/api/tickets/${staff.items[0].id}/comments`);
    expect(comments.items.map((c: { body: string; portalUser: { contact: { name: string } } | null }) => [c.body, c.portalUser?.contact.name])).toEqual([['补充：漏油位置在进油口', 'E2E 门户客户']]);
  } finally {
    await api(page, 'POST', `/api/contacts/${contact.id}/portal/disable`).catch(() => undefined);
  }
});
