/**
 * 服务工单 第一轮：功能测试（新建与默认值、工单号连续且删除后不复用、联系人必须属于客户、状态流转（解决需解决方案、
 * 解决时间、重新打开清空）、逾期、列表搜索与筛选及各状态数量、修改与删除审计（长文本脱敏）、指派通知、
 * 有工单的客户不能删除、删除联系人清空工单联系人、合并客户转移工单、演示数据）。
 * Service tickets round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as merge from '@/app/api/duplicates/merge/route';
import * as notifications from '@/app/api/notifications/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
let contact: { id: string };
const year = new Date().getUTCFullYear();
const create = (body: object, token = a.token) => call(tickets.POST, { token, body: { subject: '设备异响', accountId: acc.id, ...body } });
const patch = (id: string, body: object, token = a.token) => call(ticketItem.PATCH, { token, params: { id }, body, method: 'PATCH' });
const list = async (query: Record<string, string> = {}) => (await call(tickets.GET, { token: a.token, query })).json;
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '甲客户' } })).json;
  contact = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '张工', phone: '13800000000' } })).json;
});

describe('tickets R1 create & numbering', () => {
  it('新建默认值、工单号连续、删除后不复用 / defaults and numbering', async () => {
    const r = await create({ contactId: contact.id, description: '客户反馈怠速异响' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      ticketNumber: `CS-${year}-0001`,
      status: 'OPEN',
      priority: 'MEDIUM',
      type: 'QUESTION',
      channel: 'PHONE',
      ownerId: a.user.id,
      account: { id: acc.id, name: '甲客户' },
      contact: { id: contact.id, name: '张工' },
      resolvedAt: null,
      overdue: false,
    });
    const r2 = (await create({ subject: '第二张' })).json;
    expect(r2.ticketNumber).toBe(`CS-${year}-0002`);
    expect((await call(ticketItem.DELETE, { token: a.token, params: { id: r2.id }, method: 'DELETE' })).status).toBe(204);
    expect((await create({ subject: '第三张' })).json.ticketNumber).toBe(`CS-${year}-0003`);
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'ticket' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['ticket.create', 'ticket.create', 'ticket.delete', 'ticket.create']);
    // 描述只记“已修改” / the description is redacted
    expect(logs[0]!.changes).toMatchObject({ after: { ticketNumber: `CS-${year}-0001`, description: '[redacted]', status: 'OPEN' } });
    expect(JSON.stringify(logs[0]!.changes)).not.toContain('怠速');
  });

  it('客户与联系人校验；新建即解决需解决方案 / parties and resolution on create', async () => {
    const other = (await call(accounts.POST, { token: a.token, body: { name: '乙客户' } })).json;
    let r = await create({ accountId: other.id, contactId: contact.id });
    expect(r.status).toBe(400);
    expect(r.json.error.details).toEqual({ contactId: ['other_account'] });
    r = await create({ accountId: '00000000-0000-4000-8000-000000000000' });
    expect(r.json.error.details).toEqual({ accountId: ['not_found'] });
    r = await create({ status: 'RESOLVED' });
    expect(r.json.error.details).toEqual({ resolution: ['required'] });
    r = await create({ status: 'RESOLVED', resolution: '电话指导解决' });
    expect(r.status).toBe(201);
    expect(r.json.resolvedAt).not.toBeNull();
    for (const body of [{ subject: '  ' }, { priority: 'P1' }, { channel: 'FAX' }, { dueAt: '明天' }, { subject: 'x'.repeat(201) }]) expect((await create(body)).status).toBe(400);
  });
});

describe('tickets R1 workflow', () => {
  it('状态流转：解决需解决方案、记录解决时间、关闭保留、重新打开清空 / status flow', async () => {
    const tk = (await create({})).json;
    expect((await patch(tk.id, { status: 'IN_PROGRESS' })).json.status).toBe('IN_PROGRESS');
    expect((await patch(tk.id, { status: 'WAITING_CUSTOMER' })).json.status).toBe('WAITING_CUSTOMER');
    let r = await patch(tk.id, { status: 'RESOLVED' });
    expect(r.status).toBe(400);
    expect(r.json.error.details).toEqual({ resolution: ['required'] });
    r = await patch(tk.id, { status: 'RESOLVED', resolution: '更换密封件' });
    expect(r.json).toMatchObject({ status: 'RESOLVED', resolution: '更换密封件' });
    const resolvedAt = r.json.resolvedAt;
    expect(resolvedAt).not.toBeNull();
    // 关闭保留原解决时间 / closing keeps the resolved time
    r = await patch(tk.id, { status: 'CLOSED' });
    expect(r.json.resolvedAt).toBe(resolvedAt);
    // 已关闭不能清空解决方案 / a closed ticket cannot drop its resolution
    expect((await patch(tk.id, { resolution: null })).status).toBe(400);
    r = await patch(tk.id, { status: 'IN_PROGRESS' });
    expect(r.json).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null, resolution: '更换密封件' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: tk.id, action: 'ticket.update', changes: { path: ['fields', 'status', '1'], equals: 'RESOLVED' } } });
    expect(log.changes).toMatchObject({ fields: { status: ['WAITING_CUSTOMER', 'RESOLVED'], resolution: [null, '[redacted]'] } });
  });

  it('逾期、搜索、筛选与各状态数量 / overdue, search, filters, counts', async () => {
    const late = (await create({ subject: '逾期工单', dueAt: hours(-2), priority: 'URGENT' })).json;
    await create({ subject: '未到期', dueAt: hours(5), contactId: contact.id });
    const doneLate = (await create({ subject: '已解决的过期工单', dueAt: hours(-5), status: 'RESOLVED', resolution: '已处理' })).json;
    expect(late.overdue).toBe(true);
    expect(doneLate.overdue).toBe(false);
    const names = (r: { items: { subject: string }[] }) => r.items.map((x) => x.subject).sort();
    expect(names(await list({ overdue: 'true' }))).toEqual(['逾期工单']);
    expect(names(await list({ status: 'open' }))).toEqual(['未到期', '逾期工单'].sort());
    expect(names(await list({ status: 'RESOLVED' }))).toEqual(['已解决的过期工单']);
    expect(names(await list({ priority: 'URGENT' }))).toEqual(['逾期工单']);
    expect(names(await list({ q: '张工' }))).toEqual(['未到期']);
    expect(names(await list({ q: `CS-${year}-0001` }))).toEqual(['逾期工单']);
    expect(names(await list({ q: '甲客户' }))).toHaveLength(3);
    const r = await list({ status: 'RESOLVED' });
    // 数量不受状态筛选影响 / counts ignore the status filter
    expect(r.counts).toEqual({ OPEN: 2, IN_PROGRESS: 0, WAITING_CUSTOMER: 0, RESOLVED: 1, CLOSED: 0 });
    expect((await list({ priority: 'URGENT' })).counts.OPEN).toBe(1);
  });

  it('改派通知新负责人；换客户需联系人匹配 / reassignment notifies; account change', async () => {
    const agent = await addUser(a.org.id, 'SALES', '客服');
    const tk = (await create({ contactId: contact.id })).json;
    expect((await patch(tk.id, { ownerId: agent.user.id })).json.owner.id).toBe(agent.user.id);
    const inbox = (await call(notifications.GET, { token: agent.token })).json;
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ type: 'ASSIGNED', ticketId: tk.id, title: `${tk.ticketNumber} 设备异响` });
    // 新建时指派给他人也通知 / assigning on create notifies too
    await create({ subject: '直接指派', ownerId: agent.user.id });
    expect((await call(notifications.GET, { token: agent.token })).json.items).toHaveLength(2);
    const acc2 = (await call(accounts.POST, { token: a.token, body: { name: '新客户' } })).json;
    expect((await patch(tk.id, { accountId: acc2.id })).json.error.details).toEqual({ contactId: ['other_account'] });
    const moved = await patch(tk.id, { accountId: acc2.id, contactId: null });
    expect(moved.json).toMatchObject({ accountId: acc2.id, contactId: null });
  });
});

describe('tickets R1 related records & demo', () => {
  it('有工单的客户不能删除；删除联系人清空工单联系人 / account and contact deletion', async () => {
    const tk = (await create({ contactId: contact.id })).json;
    const r = await call(accountItem.DELETE, { token: a.token, params: { id: acc.id }, method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ tickets: ['1'] });
    expect((await call(contactItem.DELETE, { token: a.token, params: { id: contact.id }, method: 'DELETE' })).status).toBe(204);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } })).contactId).toBeNull();
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'contact.delete' } })).changes).toMatchObject({ clearedTickets: 1 });
    await call(ticketItem.DELETE, { token: a.token, params: { id: tk.id }, method: 'DELETE' });
    expect((await call(accountItem.DELETE, { token: a.token, params: { id: acc.id }, method: 'DELETE' })).status).toBe(204);
  });

  it('合并重复客户时工单转到主客户 / merging accounts moves tickets', async () => {
    const dup = (await call(accounts.POST, { token: a.token, body: { name: '甲客户（重复）' } })).json;
    const tk = (await create({ accountId: dup.id })).json;
    const r = await call(merge.POST, { token: a.token, body: { entity: 'accounts', masterId: acc.id, duplicateIds: [dup.id] } });
    expect(r.status).toBe(200);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } })).accountId).toBe(acc.id);
  });

  it('演示工单 / demo tickets', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.ticket.findMany({ where: { organizationId: org.id }, orderBy: { ticketNumber: 'asc' }, include: { contact: true } });
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.subject.startsWith('【演示】'))).toBe(true);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']));
    for (const r of rows) if (r.contact) expect(r.contact.accountId).toBe(r.accountId);
    // 计数器与已用编号一致，新建工单接着编号 / the counter matches, new tickets continue the sequence
    expect((await prisma.ticketCounter.findFirstOrThrow({ where: { organizationId: org.id } })).last).toBe(10);
    // 再次重建结果相同 / a second reset gives the same result
    await seedDemo({ reset: true });
    expect(await prisma.ticket.count({ where: { organizationId: org.id } })).toBe(10);
  });
});
