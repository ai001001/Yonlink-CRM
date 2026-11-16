/**
 * 工单导出 CSV 第一轮：功能测试（表头与内容、枚举翻译、逾期按导出时刻、评论数、多行文本与公式注入防护、
 * 与列表筛选一致（状态、未解决、优先级、逾期、搜索）、英文表头、审计只记筛选不记搜索词）。
 * Ticket CSV export round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accounts from '@/app/api/accounts/route';
import * as comments from '@/app/api/tickets/[id]/comments/route';
import * as ticketExport from '@/app/api/tickets/export/route';
import * as tickets from '@/app/api/tickets/route';
import { parseCsv } from '@/server/csv';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let acc: { id: string };
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const create = (body: object) => call(tickets.POST, { token: a.token, body: { accountId: acc.id, ...body } });

/** 调用导出并解析 / call the export and parse */
async function download(query: Record<string, string> = {}, token = a.token) {
  const url = new URL('http://localhost/api/tickets/export');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await ticketExport.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  const rows = res.status === 200 ? parseCsv((await res.text()).replace(/^﻿/, '')) : [];
  return { res, rows, subjects: rows.slice(1).map((r) => r[1]).sort() };
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  acc = (await call(accounts.POST, { token: a.token, body: { name: '星河科技' } })).json;
});

describe('ticket export R1', () => {
  it('表头与内容、逾期、评论数、多行文本、公式防护、审计 / headers, content, audit', async () => {
    const contact = (await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '张工', phone: '13800000000', email: 'zg@xinghe.example' } })).json;
    const late = (await create({ subject: '漏油', contactId: contact.id, type: 'PROBLEM', channel: 'ONSITE', priority: 'URGENT', dueAt: hours(-2), description: '第一行\n第二行，含逗号' })).json;
    await call(comments.POST, { token: a.token, params: { id: late.id }, body: { body: '已联系' } });
    await call(comments.POST, { token: a.token, params: { id: late.id }, body: { body: '内部', isInternal: true } });
    await create({ subject: '=1+1 公式', status: 'RESOLVED', resolution: '已处理', dueAt: hours(-5) });

    const { res, rows } = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Export-Count')).toBe('2');
    expect(res.headers.get('X-Export-Truncated')).toBe('false');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="tickets-\d{8}\.csv"$/);
    expect(rows[0]!.slice(0, 12)).toEqual(['工单号', '主题', '客户', '联系人', '电话', '邮箱', '类型', '来源渠道', '优先级', '状态', '已逾期', '负责人']);
    expect(rows[0]![12]).toContain('处理期限');
    expect(rows[0]!.slice(15)).toEqual(['处理记录数', '备注', '解决方案']);
    expect(rows[0]).toHaveLength(18);
    // 最新在前 / newest first
    const [resolved, open] = [rows[1]!, rows[2]!];
    expect(open.slice(0, 12)).toEqual([late.ticketNumber, '漏油', '星河科技', '张工', '13800000000', 'zg@xinghe.example', '故障', '现场', '紧急', '新建', '是', a.user.name]);
    expect(open[13]).toBe('');
    expect(open[15]).toBe('2');
    expect(open[16]).toBe('第一行\n第二行，含逗号');
    // 已解决的过期工单不算逾期；公式开头加单引号 / resolved tickets are not overdue; formulas are neutralised
    expect(resolved[1]).toBe("'=1+1 公式");
    expect(resolved[9]).toBe('已解决');
    expect(resolved[10]).toBe('否');
    expect(resolved[13]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(resolved[17]).toBe('已处理');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.export' } });
    expect(log).toMatchObject({ entityType: 'ticket', changes: { count: 2, truncated: false, searched: false, filters: {} } });
  });

  it('与列表筛选一致；审计不记搜索词；英文表头 / filters, search, English', async () => {
    await create({ subject: '紧急逾期', priority: 'URGENT', dueAt: hours(-1) });
    await create({ subject: '处理中', status: 'IN_PROGRESS', dueAt: hours(10) });
    await create({ subject: '已关闭', status: 'CLOSED', resolution: '完成' });
    expect((await download({ status: 'open' })).subjects).toEqual(['处理中', '紧急逾期'].sort());
    expect((await download({ status: 'CLOSED' })).subjects).toEqual(['已关闭']);
    expect((await download({ priority: 'URGENT' })).subjects).toEqual(['紧急逾期']);
    expect((await download({ overdue: 'true' })).subjects).toEqual(['紧急逾期']);
    expect((await download({ q: '处理' })).subjects).toEqual(['处理中']);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.export', changes: { path: ['searched'], equals: true } } });
    expect(JSON.stringify(log.changes)).not.toContain('处理');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.export', changes: { path: ['filters', 'status'], equals: 'CLOSED' } } })).changes).toMatchObject({ count: 1 });
    const en = await download({ lang: 'en-US', status: 'CLOSED' });
    expect(en.rows[0]!.slice(0, 3)).toEqual(['Ticket no.', 'Subject', 'Account']);
    expect(en.rows[1]![9]).toBe('Closed');
  });
});
