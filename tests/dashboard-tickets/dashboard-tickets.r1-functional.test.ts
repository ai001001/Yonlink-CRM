/**
 * 工作台“我的待处理工单”卡片 第一轮：功能测试（默认布局包含该卡片、只含我负责的未解决工单、按优先级再按处理期限
 * 排序且无期限排最后、逾期计数、最多 10 条但总数照常、解决后移出、隐藏时不计算；演示数据三位负责人都有未解决工单）。
 * Dashboard "my pending tickets" card round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as layout from '@/app/api/dashboard/layout/route';
import * as dashboard from '@/app/api/dashboard/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import { prisma } from '@/server/db';
import { DEFAULT_WIDGETS } from '@/server/modules/dashboard-layout';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const create = (body: object) => call(tickets.POST, { token: a.token, body: { accountId: acc.id, ...body } });
const card = async (token = a.token) => (await call(dashboard.GET, { token })).json.myTickets;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '甲客户' } })).json;
});

describe('dashboard my tickets R1', () => {
  it('默认布局包含该卡片，位于我的待办之后；无工单时为空 / default layout and empty card', async () => {
    expect(DEFAULT_WIDGETS.indexOf('myTickets')).toBe(DEFAULT_WIDGETS.indexOf('myTodos') + 1);
    expect((await call(layout.GET, { token: a.token })).json.widgets).toContain('myTickets');
    expect(await card()).toEqual({ items: [], total: 0, overdue: 0 });
  });

  it('只含我负责的未解决工单；按优先级、处理期限排序，无期限最后 / mine, unresolved, ordered', async () => {
    const colleague = await addUser(a.org.id, 'MANAGER', '同事');
    await create({ subject: '低-明天', priority: 'LOW', dueAt: hours(24) });
    await create({ subject: '高-无期限', priority: 'HIGH' });
    await create({ subject: '高-后天', priority: 'HIGH', dueAt: hours(48) });
    await create({ subject: '高-已逾期', priority: 'HIGH', dueAt: hours(-3), status: 'IN_PROGRESS' });
    await create({ subject: '紧急-等待客户', priority: 'URGENT', status: 'WAITING_CUSTOMER' });
    await create({ subject: '已解决', priority: 'URGENT', status: 'RESOLVED', resolution: '已处理' });
    await create({ subject: '已关闭', priority: 'URGENT', status: 'CLOSED', resolution: '已处理', dueAt: hours(-10) });
    await create({ subject: '同事的', priority: 'URGENT', ownerId: colleague.user.id });
    const c = await card();
    expect(c.items.map((x: { subject: string }) => x.subject)).toEqual(['紧急-等待客户', '高-已逾期', '高-后天', '高-无期限', '低-明天']);
    expect(c.total).toBe(5);
    expect(c.overdue).toBe(1);
    expect(c.items[1]).toMatchObject({ overdue: true, status: 'IN_PROGRESS', account: { id: acc.id, name: '甲客户' } });
    expect(c.items[0]).toMatchObject({ overdue: false, ticketNumber: expect.stringMatching(/^CS-\d{4}-\d{4}$/) });
    // 同事的工单出现在同事的卡片中 / the colleague's ticket shows on their card
    expect((await card(colleague.token)).items.map((x: { subject: string }) => x.subject)).toEqual(['同事的']);
  });

  it('解决后移出、最多 10 条但总数照常、隐藏时不计算 / resolved leave, limit, hidden', async () => {
    const first = (await create({ subject: '将被解决', priority: 'URGENT' })).json;
    for (let i = 0; i < 11; i++) await create({ subject: `批量${i}` });
    let c = await card();
    expect(c.total).toBe(12);
    expect(c.items).toHaveLength(10);
    expect(c.items[0].subject).toBe('将被解决');
    await call(ticketItem.PATCH, { token: a.token, params: { id: first.id }, body: { status: 'RESOLVED', resolution: '完成' }, method: 'PATCH' });
    c = await card();
    expect(c.total).toBe(11);
    expect(c.items.map((x: { subject: string }) => x.subject)).not.toContain('将被解决');
    // 重新打开后回到卡片 / reopening brings it back
    await call(ticketItem.PATCH, { token: a.token, params: { id: first.id }, body: { status: 'IN_PROGRESS' }, method: 'PATCH' });
    expect((await card()).items[0].subject).toBe('将被解决');
    await call(layout.PUT, { token: a.token, body: { widgets: ['counts'] }, method: 'PUT' });
    expect(await card()).toBeNull();
  });

  it('演示数据：三位负责人都有未解决工单，且客户归负责人 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const open = await prisma.ticket.findMany({
      where: { organizationId: org.id, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] } },
      include: { account: { select: { ownerId: true } } },
    });
    expect(new Set(open.map((t) => t.ownerId)).size).toBe(3);
    for (const t of open) expect(t.account.ownerId).toBe(t.ownerId);
  });
});
