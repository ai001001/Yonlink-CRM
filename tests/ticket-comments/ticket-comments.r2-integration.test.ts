/**
 * 工单评论 第二轮：集成测试（销售只能在自己的工单上评论、看不到他人工单的评论；只读可查看不能发表；只有作者能修改；
 * 作者或经理、管理员能删除；改派后原负责人无法再修改自己的评论；跨组织隔离；未登录；并发发表；跨域预检）。
 * Ticket comments round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as commentItem from '@/app/api/ticket-comments/[id]/route';
import * as comments from '@/app/api/tickets/[id]/comments/route';
import * as ticketItem from '@/app/api/tickets/[id]/route';
import * as tickets from '@/app/api/tickets/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let tk1: { id: string };
let tk2: { id: string };
const post = (who: Who, id: string, body: object = { body: '记录' }) => call(comments.POST, { token: who.token, params: { id }, body });
const edit = (who: Who, id: string) => call(commentItem.PATCH, { token: who.token, params: { id }, body: { body: '改' }, method: 'PATCH' });
const del = (who: Who, id: string) => call(commentItem.DELETE, { token: who.token, params: { id }, method: 'DELETE' });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  const acc = (await call(accounts.POST, { token: admin.token, body: { name: '客户' } })).json;
  tk1 = (await call(tickets.POST, { token: admin.token, body: { subject: '销售1工单', accountId: acc.id, ownerId: sales1.user.id } })).json;
  tk2 = (await call(tickets.POST, { token: admin.token, body: { subject: '销售2工单', accountId: acc.id, ownerId: sales2.user.id } })).json;
});

describe('ticket comments R2 permissions', () => {
  it('销售只在自己的工单上评论；只读只能查看 / sales and readonly', async () => {
    expect((await post(sales1, tk1.id)).status).toBe(201);
    await post(sales2, tk2.id);
    expect((await post(sales1, tk2.id)).status).toBe(404);
    expect((await call(comments.GET, { token: sales1.token, params: { id: tk2.id } })).status).toBe(404);
    const theirs = await prisma.ticketComment.findFirstOrThrow({ where: { ticketId: tk2.id } });
    expect((await edit(sales1, theirs.id)).status).toBe(404);
    expect((await del(sales1, theirs.id)).status).toBe(404);
    expect((await call(comments.GET, { token: viewer.token, params: { id: tk1.id } })).json.items).toHaveLength(1);
    expect((await post(viewer, tk1.id)).status).toBe(403);
    expect(await prisma.ticketComment.count()).toBe(2);
  });

  it('只有作者能修改；作者或经理、管理员能删除 / edit by author, delete by author or managers', async () => {
    const c = (await post(sales1, tk1.id)).json;
    const r = await edit(manager, c.id);
    expect(r.status).toBe(403);
    expect(r.json.error.details).toEqual({ comment: ['not_author'] });
    expect((await edit(admin, c.id)).status).toBe(403);
    // 经理在销售的工单上发表，销售（负责人）不能删除经理的评论 / the owner cannot delete a manager's comment
    const m = (await post(manager, tk1.id)).json;
    expect((await del(sales1, m.id)).status).toBe(403);
    expect((await del(manager, c.id)).status).toBe(204);
    expect((await del(admin, m.id)).status).toBe(204);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ticket.comment_delete', changes: { path: ['commentId'], equals: c.id } } })).actorId).toBe(manager.user.id);
  });

  it('改派后原负责人看不到工单，也不能再修改自己的评论 / reassignment', async () => {
    const c = (await post(sales1, tk1.id)).json;
    await call(ticketItem.PATCH, { token: admin.token, params: { id: tk1.id }, body: { ownerId: sales2.user.id }, method: 'PATCH' });
    expect((await edit(sales1, c.id)).status).toBe(404);
    expect((await call(comments.GET, { token: sales2.token, params: { id: tk1.id } })).json.items[0].author.id).toBe(sales1.user.id);
  });

  it('跨组织隔离与未登录 / cross-tenant and auth', async () => {
    const c = (await post(admin, tk1.id)).json;
    expect((await call(comments.GET, { token: other.token, params: { id: tk1.id } })).status).toBe(404);
    expect((await post(other, tk1.id)).status).toBe(404);
    expect((await edit(other, c.id)).status).toBe(404);
    expect((await del(other, c.id)).status).toBe(404);
    expect((await call(comments.GET, { params: { id: tk1.id } })).status).toBe(401);
    expect((await call(comments.POST, { params: { id: tk1.id }, body: { body: 'x' } })).status).toBe(401);
    expect((await call(commentItem.DELETE, { params: { id: c.id }, method: 'DELETE' })).status).toBe(401);
  });
});

describe('ticket comments R2 concurrency & cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('并发发表全部保存，通知与审计各一条 / concurrent posts', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post(manager, tk1.id, { body: `并发${i}` })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await prisma.ticketComment.count({ where: { ticketId: tk1.id } })).toBe(8);
    expect(await prisma.notification.count({ where: { userId: sales1.user.id, type: 'TICKET_COMMENT' } })).toBe(8);
    expect(await prisma.auditLog.count({ where: { action: 'ticket.comment', entityId: tk1.id } })).toBe(8);
  });

  it('跨域预检 / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    for (const route of [comments, commentItem]) {
      const res = await route.OPTIONS(new Request('http://localhost/api/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    }
  });
});
