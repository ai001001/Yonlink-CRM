/**
 * 工作台“我的待处理工单”卡片 第二轮：集成测试（销售、经理、只读各只看自己负责的；改派后从原负责人卡片移到新负责人卡片；
 * 跨组织隔离；未登录；旧的自定义布局不自动加入新卡片，可手动加入）。
 * Dashboard "my pending tickets" card round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as layout from '@/app/api/dashboard/layout/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let viewer: Who;
let acc: { id: string };
const subjects = async (who: Who) => ((await call(dashboard.GET, { token: who.token })).json.myTickets?.items ?? []).map((x: { subject: string }) => x.subject);

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
  acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户', ownerId: sales1.user.id } })).json;
});

describe('dashboard my tickets R2', () => {
  it('各角色只看自己负责的；改派后转到新负责人 / per owner, reassignment', async () => {
    const tk = (await call(tickets.POST, { token: admin.token, body: { subject: '工单甲', accountId: acc.id, ownerId: sales1.user.id } })).json;
    await call(tickets.POST, { token: admin.token, body: { subject: '管理员的', accountId: acc.id } });
    expect(await subjects(sales1)).toEqual(['工单甲']);
    // 经理能看全部工单，但卡片只列自己负责的 / managers see every ticket, yet the card lists their own only
    expect(await subjects(manager)).toEqual([]);
    expect(await subjects(viewer)).toEqual([]);
    expect(await subjects(admin)).toEqual(['管理员的']);
    await call(ticketItem.PATCH, { token: admin.token, params: { id: tk.id }, body: { ownerId: manager.user.id }, method: 'PATCH' });
    expect(await subjects(sales1)).toEqual([]);
    expect(await subjects(manager)).toEqual(['工单甲']);
    expect(await subjects(other)).toEqual([]);
    expect((await call(dashboard.GET)).status).toBe(401);
  });

  it('旧的自定义布局不自动加入新卡片，可手动加入 / saved layouts keep their choice', async () => {
    await call(tickets.POST, { token: sales1.token, body: { subject: '我的工单', accountId: acc.id } });
    await call(layout.PUT, { token: sales1.token, body: { widgets: ['myTodos', 'stages'] }, method: 'PUT' });
    expect((await call(dashboard.GET, { token: sales1.token })).json.myTickets).toBeNull();
    await call(layout.PUT, { token: sales1.token, body: { widgets: ['myTickets', 'myTodos'] }, method: 'PUT' });
    const d = (await call(dashboard.GET, { token: sales1.token })).json;
    expect(d.layout).toEqual(['myTickets', 'myTodos']);
    expect(d.myTickets.items.map((x: { subject: string }) => x.subject)).toEqual(['我的工单']);
  });
});
