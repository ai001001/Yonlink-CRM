/**
 * 工单评论 第一轮：功能测试（发表对外回复与内部备注、按时间排序、去除首尾空白、修改记录编辑时间、删除；
 * 审计不含内容；他人评论通知负责人、本人评论不通知；评论不改变工单版本；删除工单级联删除评论；演示数据）。
 * Ticket comments round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_TICKET_COMMENTS } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as notifications from '@/app/api/notifications/route';
import * as commentItem from '@/app/api/ticket-comments/[id]/route';
import * as comments from '@/app/api/tickets/[id]/comments/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let tk: { id: string; ticketNumber: string; updatedAt: string };
const post = (body: object, token = a.token, id = tk.id) => call(comments.POST, { token, params: { id }, body });
const list = async (token = a.token) => (await call(comments.GET, { token, params: { id: tk.id } })).json.items;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
  tk = (await call(tickets.POST, { token: a.token, body: { subject: '异响', accountId: acc.id } })).json;
});

describe('ticket comments R1', () => {
  it('发表、排序、去空白；审计不含内容 / post, order, trim, audit', async () => {
    const r = await post({ body: '  已电话联系客户  ' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ body: '已电话联系客户', isInternal: false, editedAt: null, author: { id: a.user.id } });
    await post({ body: '内部：需要上门', isInternal: true });
    expect((await list()).map((c: { body: string; isInternal: boolean }) => [c.body, c.isInternal])).toEqual([
      ['已电话联系客户', false],
      ['内部：需要上门', true],
    ]);
    for (const body of [{ body: '   ' }, { body: 'x'.repeat(5001) }, {}, { body: 'x', isInternal: 'yes' }, { body: 'x', authorId: a.user.id }]) expect((await post(body)).status).toBe(400);
    const logs = await prisma.auditLog.findMany({ where: { action: 'ticket.comment', entityId: tk.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.changes)).toEqual([
      { commentId: r.json.id, isInternal: false, length: 7 },
      { commentId: expect.any(String), isInternal: true, length: 7 },
    ]);
    expect(JSON.stringify(logs)).not.toContain('电话');
  });

  it('修改自己的评论记录编辑时间；删除；审计 / edit and delete', async () => {
    const c = (await post({ body: '初稿' })).json;
    const up = await call(commentItem.PATCH, { token: a.token, params: { id: c.id }, body: { body: '修改后', isInternal: true }, method: 'PATCH' });
    expect(up.json).toMatchObject({ body: '修改后', isInternal: true });
    expect(up.json.editedAt).not.toBeNull();
    expect((await call(commentItem.PATCH, { token: a.token, params: { id: c.id }, body: {}, method: 'PATCH' })).status).toBe(400);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.comment_update' } });
    expect(log.changes).toEqual({ commentId: c.id, fields: { body: ['[redacted]', '[redacted]'], isInternal: [false, true] } });
    expect((await call(commentItem.DELETE, { token: a.token, params: { id: c.id }, method: 'DELETE' })).status).toBe(204);
    expect((await call(commentItem.DELETE, { token: a.token, params: { id: c.id }, method: 'DELETE' })).status).toBe(404);
    expect(await list()).toEqual([]);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.comment_delete' } })).changes).toEqual({ commentId: c.id, authorId: a.user.id, isInternal: true, length: 3 });
  });

  it('他人评论通知负责人，本人评论不通知；评论不改变工单版本 / notify owner; ticket version unchanged', async () => {
    const mgr = await addUser(a.org.id, 'MANAGER', '经理');
    await post({ body: '我自己的记录' });
    expect((await call(notifications.GET, { token: a.token })).json.items).toEqual([]);
    await post({ body: '经理补充' }, mgr.token);
    const inbox = (await call(notifications.GET, { token: a.token })).json.items;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ type: 'TICKET_COMMENT', ticketId: tk.id, title: `${tk.ticketNumber} 异响`, actor: { id: mgr.user.id } });
    // 工单 updatedAt 不变：基于旧版本的修改仍可保存 / updatedAt unchanged: an edit based on the old version still saves
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } })).updatedAt.toISOString()).toBe(tk.updatedAt);
    expect((await call(ticketItem.PATCH, { token: a.token, params: { id: tk.id }, body: { priority: 'HIGH' }, method: 'PATCH' })).status).toBe(200);
  });

  it('删除工单级联删除评论并记录数量 / deleting the ticket removes comments', async () => {
    await post({ body: '一' });
    await post({ body: '二', isInternal: true });
    expect((await call(ticketItem.DELETE, { token: a.token, params: { id: tk.id }, method: 'DELETE' })).status).toBe(204);
    expect(await prisma.ticketComment.count()).toBe(0);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.delete' } })).changes).toMatchObject({ cascadedComments: 2 });
  });

  it('演示评论 / demo comments', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const rows = await prisma.ticketComment.findMany({ where: { organizationId: org.id }, include: { ticket: { select: { ownerId: true, subject: true, createdAt: true } } } });
    expect(rows).toHaveLength(Object.values(DEMO_TICKET_COMMENTS).flat().length);
    for (const c of rows) {
      expect(c.authorId).toBe(c.ticket.ownerId);
      expect(c.createdAt.getTime()).toBeGreaterThanOrEqual(c.ticket.createdAt.getTime());
      expect(c.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(DEMO_TICKET_COMMENTS[c.ticket.subject]).toBeDefined();
    }
  });
});
