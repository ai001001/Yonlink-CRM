/**
 * 跟进 第一轮：功能测试（电话/会议/拜访/任务、完成状态、关联客户/线索/商机、编辑、删除）。
 * Activities round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as collection from '@/app/api/activities/route';
import * as item from '@/app/api/activities/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
let lead: { id: string };
let deal: { id: string };
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '南京钟山软件' } })).json;
  lead = (await call(leads.POST, { token: a.token, body: { name: '刘线索' } })).json;
  deal = (await call(deals.POST, { token: a.token, body: { name: 'ERP 实施', accountId: acc.id } })).json;
});

const mk = (body: object) => call(collection.POST, { token: a.token, body });

describe('activities R1 functional', () => {
  it.each([
    ['CALL', '电话记录'],
    ['MEETING', '会议记录'],
    ['VISIT', '客户拜访记录'],
    ['TASK', '任务'],
  ])('新增 %s（%s）/ create each type', async (type, subject) => {
    const res = await mk({ type, subject, content: '详细内容', accountId: acc.id });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ type, subject, content: '详细内容', completed: false, completedAt: null, ownerId: a.user.id });
  });

  it('同时关联客户、线索和商机，并返回关联名称 / link account, lead and deal together', async () => {
    const res = await mk({ type: 'MEETING', subject: '三方会议', accountId: acc.id, leadId: lead.id, dealId: deal.id });
    expect(res.json).toMatchObject({
      account: { id: acc.id, name: '南京钟山软件' },
      lead: { id: lead.id, name: '刘线索' },
      deal: { id: deal.id, name: 'ERP 实施' },
    });
    for (const query of [{ accountId: acc.id }, { leadId: lead.id }, { dealId: deal.id }] as Record<string, string>[]) {
      expect((await call(collection.GET, { token: a.token, query })).json.total).toBe(1);
    }
  });

  it('任务带截止时间（UTC 保存）/ task with due time stored as UTC', async () => {
    const res = await mk({ type: 'TASK', subject: '发送报价单', dueAt: '2027-01-15T10:30:00+08:00' });
    expect(res.json.dueAt).toBe('2027-01-15T02:30:00.000Z');
  });

  it('完成状态：标记完成记录时间，重新打开清空时间 / complete sets completedAt, reopen clears it', async () => {
    const t = (await mk({ type: 'TASK', subject: '回访' })).json;
    const done = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: t.id }, body: { completed: true } });
    expect(done.json.completed).toBe(true);
    expect(done.json.completedAt).not.toBeNull();
    const again = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: t.id }, body: { subject: '回访（已改）' } });
    expect(again.json.completedAt).toBe(done.json.completedAt);
    const reopened = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: t.id }, body: { completed: false } });
    expect(reopened.json).toMatchObject({ completed: false, completedAt: null });
  });

  it('新建即完成（电话记录）/ create already completed', async () => {
    const res = await mk({ type: 'CALL', subject: '已打电话', completed: true, leadId: lead.id });
    expect(res.json.completed).toBe(true);
    expect(res.json.completedAt).not.toBeNull();
  });

  it('编辑：只改主题不影响截止时间与关联；可清除关联 / partial update keeps other fields; relations can be cleared', async () => {
    const x = (await mk({ type: 'TASK', subject: '原主题', dueAt: '2027-02-01T00:00:00Z', accountId: acc.id, dealId: deal.id })).json;
    const r1 = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: x.id }, body: { subject: '新主题', type: 'CALL' } });
    expect(r1.json).toMatchObject({ subject: '新主题', type: 'CALL', dueAt: '2027-02-01T00:00:00.000Z', accountId: acc.id, dealId: deal.id });
    const r2 = await call(item.PATCH, { token: a.token, method: 'PATCH', params: { id: x.id }, body: { dealId: null, leadId: lead.id } });
    expect(r2.json).toMatchObject({ dealId: null, leadId: lead.id, accountId: acc.id });
  });

  it('详情与删除 / detail and delete', async () => {
    const x = (await mk({ type: 'VISIT', subject: '上门' })).json;
    expect((await call(item.GET, { token: a.token, params: { id: x.id } })).json.subject).toBe('上门');
    expect((await call(item.DELETE, { token: a.token, method: 'DELETE', params: { id: x.id } })).status).toBe(204);
    expect(await prisma.activity.count()).toBe(0);
  });

  it('按类型、完成状态筛选，按主题/内容搜索 / filter by type and status, search subject/content', async () => {
    await mk({ type: 'CALL', subject: '电话甲', content: '谈到预算' });
    await mk({ type: 'TASK', subject: '任务乙', completed: true });
    const subj = async (query: Record<string, string>) =>
      (await call(collection.GET, { token: a.token, query })).json.items.map((x: { subject: string }) => x.subject);
    expect(await subj({ type: 'CALL' })).toEqual(['电话甲']);
    expect(await subj({ completed: 'true' })).toEqual(['任务乙']);
    expect(await subj({ completed: 'false' })).toEqual(['电话甲']);
    expect(await subj({ q: '预算' })).toEqual(['电话甲']);
  });

  it('按截止时间排序：最早在前，无截止时间排最后 / sort by due date, nulls last', async () => {
    await mk({ type: 'TASK', subject: '无截止' });
    await mk({ type: 'TASK', subject: '后天', dueAt: '2027-03-03T00:00:00Z' });
    await mk({ type: 'TASK', subject: '明天', dueAt: '2027-03-02T00:00:00Z' });
    const res = await call(collection.GET, { token: a.token, query: { sort: 'dueAt' } });
    expect(res.json.items.map((x: { subject: string }) => x.subject)).toEqual(['明天', '后天', '无截止']);
  });
});
