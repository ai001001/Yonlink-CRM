/**
 * 客户 第三轮：端到端回归（客户 → 联系人 → 跟进记录 → 搜索 → 编辑 → 删除）。
 * Accounts round 3: end-to-end regression.
 */
import { expect, test } from '@playwright/test';
import { closeDrawer, nav, searchList, selectOption, signIn } from './helpers';

const SAVE = /保\s*存/;

test('客户完整业务流程 / full accounts flow', async ({ page }) => {
  await signIn(page);
  await nav(page, '客户');
  await expect(page.getByText('客户管理')).toBeVisible();

  // 新增客户 / create account
  await page.getByRole('button', { name: '新增客户' }).click();
  let dialog = page.getByRole('dialog', { name: '新增客户' });
  await dialog.getByLabel('客户名称').fill('E2E 远望制造');
  await selectOption(page, dialog, '行业', '制造业');
  await dialog.getByLabel('电话').fill('0571-12345678');
  await dialog.getByLabel('地址').fill('杭州市滨江区');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByText('保存成功').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 远望制造/ })).toContainText('制造业');

  // 详情 + 联系人 / detail + contacts
  await page.getByRole('button', { name: 'E2E 远望制造' }).click();
  const drawer = page.getByRole('dialog', { name: /客户详情/ });
  await expect(drawer).toContainText('杭州市滨江区');
  await drawer.getByRole('tab', { name: /联系人/ }).click();
  await drawer.getByRole('button', { name: '新增联系人' }).click();
  dialog = page.getByRole('dialog', { name: '新增联系人' });
  await dialog.getByLabel('姓名').fill('欧阳经理');
  await dialog.getByLabel('邮箱').fill('ouyang@example.com');
  await dialog.getByLabel('主要联系人').check();
  await dialog.getByRole('button', { name: SAVE }).click();
  const contacts = drawer.getByTestId('contacts-panel');
  await expect(contacts.getByRole('row', { name: /欧阳经理/ })).toContainText('主要联系人');
  await expect(drawer.getByRole('tab', { name: '联系人 (1)' })).toBeVisible();

  // 编辑联系人 / edit contact
  await contacts.getByRole('row', { name: /欧阳经理/ }).getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑联系人' });
  await dialog.getByLabel('职位').fill('采购总监');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(contacts.getByRole('row', { name: /欧阳经理/ })).toContainText('采购总监');

  // 跟进记录 / follow-up
  await drawer.getByRole('tab', { name: '跟进记录' }).click();
  await drawer.getByRole('button', { name: '新增跟进' }).click();
  dialog = page.getByRole('dialog', { name: '新增跟进' });
  await selectOption(page, dialog, '类型', '客户拜访');
  await dialog.getByLabel('主题').fill('E2E 上门拜访');
  await dialog.getByLabel('内容').fill('确认了二期需求');
  await dialog.getByRole('button', { name: SAVE }).click();
  const timeline = drawer.getByTestId('related-activities');
  await expect(timeline).toContainText('E2E 上门拜访');
  await expect(timeline).toContainText('客户拜访');
  await expect(timeline).toContainText('确认了二期需求');
  await closeDrawer(page, drawer);

  // 按联系人姓名搜索客户 / search by contact name
  await searchList(page, '搜索客户名称、电话、网站、地址、联系人', '欧阳');
  await expect(page.getByRole('row', { name: /E2E 远望制造/ })).toBeVisible();
  await searchList(page, '搜索客户名称、电话、网站、地址、联系人', '不存在的客户');
  await expect(page.getByRole('row', { name: /E2E 远望制造/ })).toHaveCount(0);
  await searchList(page, '搜索客户名称、电话、网站、地址、联系人', '');

  // 编辑客户 / edit account
  const row = page.getByRole('row', { name: /E2E 远望制造/ });
  await row.getByRole('button', { name: /编\s*辑/ }).click();
  dialog = page.getByRole('dialog', { name: '编辑客户' });
  await dialog.getByLabel('客户名称').fill('E2E 远望集团');
  await dialog.getByRole('button', { name: SAVE }).click();
  await expect(page.getByRole('row', { name: /E2E 远望集团/ })).toContainText('1');

  // 刷新后持久化，然后删除 / persisted after reload, then delete
  await page.reload();
  const saved = page.getByRole('row', { name: /E2E 远望集团/ });
  await expect(saved).toBeVisible();
  await saved.getByRole('button', { name: /删\s*除/ }).click();
  await page.getByRole('button', { name: /确\s*定|OK/ }).click();
  await expect(page.getByText('已移入回收站').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E 远望集团/ })).toHaveCount(0);
});
