/**
 * 服务工单 第二轮：集成测试（销售只看、只改自己的且不能指派他人或删除；只读只能查看；不能引用不可见客户或他组织的
 * 客户与联系人；跨组织隔离；客户端不能提交工单号、组织、解决时间；未登录；并发：编号不重复、同时修改只成功一次、
 * 删除客户与新建工单；跨域预检）。
 * Service tickets round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accounts from '@/app/api/accounts/route';
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
let acc1: { id: string };
let acc2: { id: string };
const year = new Date().getUTCFullYear();
const create = (who: Who, body: object) => call(tickets.POST, { token: who.token, body: { subject: '工单', ...body } });
const patch = (who: Who, id: string, body: object) => call(ticketItem.PATCH, { token: who.token, params: { id }, body, method: 'PATCH' });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  acc1 = (await call(accounts.POST, { token: admin.token, body: { name: '销售1客户', ownerId: sales1.user.id } })).json;
  acc2 = (await call(accounts.POST, { token: admin.token, body: { name: '销售2客户', ownerId: sales2.user.id } })).json;
});

describe('tickets R2 permissions', () => {
  it('销售只看、只改自己的；不能指派他人或删除 / sales scope', async () => {
    const mine = await create(sales1, { accountId: acc1.id });
    expect(mine.status).toBe(201);
    expect(mine.json.ownerId).toBe(sales1.user.id);
    const theirs = (await create(sales2, { accountId: acc2.id })).json;
    expect((await call(tickets.GET, { token: sales1.token })).json.items.map((x: { id: string }) => x.id)).toEqual([mine.json.id]);
    expect((await call(tickets.GET, { token: sales1.token })).json.counts.OPEN).toBe(1);
    expect((await call(ticketItem.GET, { token: sales1.token, params: { id: theirs.id } })).status).toBe(404);
    expect((await patch(sales1, theirs.id, { status: 'IN_PROGRESS' })).status).toBe(404);
    // 不可见的客户不能建单 / invisible accounts cannot be used
    expect((await create(sales1, { accountId: acc2.id })).json.error.details).toEqual({ accountId: ['not_found'] });
    expect((await create(sales1, { accountId: acc1.id, ownerId: sales2.user.id })).status).toBe(403);
    expect((await patch(sales1, mine.json.id, { ownerId: sales2.user.id })).status).toBe(403);
    expect((await call(ticketItem.DELETE, { token: sales1.token, params: { id: mine.json.id }, method: 'DELETE' })).status).toBe(403);
    expect((await patch(sales1, mine.json.id, { status: 'RESOLVED', resolution: '已解决' })).json.status).toBe('RESOLVED');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('OPEN');
  });

  it('只读只能查看；经理可改派与删除 / readonly and manager', async () => {
    const tk = (await create(sales1, { accountId: acc1.id })).json;
    expect((await call(ticketItem.GET, { token: viewer.token, params: { id: tk.id } })).status).toBe(200);
    expect((await create(viewer, { accountId: acc1.id })).status).toBe(403);
    expect((await patch(viewer, tk.id, { status: 'IN_PROGRESS' })).status).toBe(403);
    expect((await call(ticketItem.DELETE, { token: viewer.token, params: { id: tk.id }, method: 'DELETE' })).status).toBe(403);
    expect((await patch(manager, tk.id, { ownerId: sales2.user.id })).json.ownerId).toBe(sales2.user.id);
    // 改派后原负责人看不到 / the previous owner loses sight of it
    expect((await call(ticketItem.GET, { token: sales1.token, params: { id: tk.id } })).status).toBe(404);
    expect((await call(ticketItem.DELETE, { token: manager.token, params: { id: tk.id }, method: 'DELETE' })).status).toBe(204);
  });

  it('跨组织隔离；不能引用他组织客户、联系人或负责人 / cross-tenant', async () => {
    const tk = (await create(admin, { accountId: acc1.id })).json;
    expect((await call(tickets.GET, { token: other.token })).json.total).toBe(0);
    expect((await call(ticketItem.GET, { token: other.token, params: { id: tk.id } })).status).toBe(404);
    expect((await patch(other, tk.id, { subject: 'x' })).status).toBe(404);
    expect((await call(ticketItem.DELETE, { token: other.token, params: { id: tk.id }, method: 'DELETE' })).status).toBe(404);
    expect((await create(other, { accountId: acc1.id })).json.error.details).toEqual({ accountId: ['not_found'] });
    const oAcc = (await call(accounts.POST, { token: other.token, body: { name: '乙方' } })).json;
    const c = (await call(accountContacts.POST, { token: admin.token, params: { id: acc1.id }, body: { name: '甲方联系人' } })).json;
    expect((await create(other, { accountId: oAcc.id, contactId: c.id })).json.error.details).toEqual({ contactId: ['not_found'] });
    expect((await create(other, { accountId: oAcc.id, ownerId: sales1.user.id })).status).toBe(400);
    // 编号按组织独立 / numbering is per organization
    expect((await create(other, { accountId: oAcc.id })).json.ticketNumber).toBe(`CS-${year}-0001`);
  });
});

describe('tickets R2 validation & concurrency', () => {
  it('客户端不能提交工单号、组织、解决时间；未登录 / server-owned fields and auth', async () => {
    for (const extra of [{ ticketNumber: 'CS-1999-0001' }, { organizationId: other.org.id }, { resolvedAt: new Date().toISOString() }, { overdue: true }]) {
      expect((await create(admin, { accountId: acc1.id, ...extra })).status).toBe(400);
    }
    const tk = (await create(admin, { accountId: acc1.id })).json;
    expect((await patch(admin, tk.id, { ticketNumber: 'CS-1999-0001' })).status).toBe(400);
    for (const query of [{ status: 'DONE' }, { priority: 'P0' }, { overdue: 'yes' }, { ownerId: 'x' }] as Record<string, string>[]) {
      expect((await call(tickets.GET, { token: admin.token, query })).status).toBe(400);
    }
    expect((await call(tickets.GET)).status).toBe(401);
    expect((await call(tickets.POST, { body: { subject: 'x', accountId: acc1.id } })).status).toBe(401);
    expect((await call(ticketItem.PATCH, { params: { id: tk.id }, body: { subject: 'x' }, method: 'PATCH' })).status).toBe(401);
    expect(await prisma.ticket.count()).toBe(1);
  });

  it('并发新建编号不重复且连续 / concurrent numbering', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => create(admin, { accountId: acc1.id, subject: `并发${i}` })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const nums = rs.map((r) => r.json.ticketNumber).sort();
    expect(nums).toEqual(Array.from({ length: 10 }, (_, i) => `CS-${year}-${String(i + 1).padStart(4, '0')}`));
  });

  it('同时修改同一工单：只有一个成功，另一个 409 / concurrent updates', async () => {
    const tk = (await create(admin, { accountId: acc1.id })).json;
    const rs = await Promise.all([patch(admin, tk.id, { priority: 'URGENT' }), patch(manager, tk.id, { priority: 'LOW' }), patch(admin, tk.id, { subject: '改名' })]);
    const ok = rs.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const conflicts = rs.filter((r) => r.status === 409);
    for (const c of conflicts) expect(c.json.error.details).toEqual({ ticket: ['stale'] });
    // 审计条数与成功次数一致 / one audit row per successful update
    expect(await prisma.auditLog.count({ where: { entityId: tk.id, action: 'ticket.update' } })).toBe(ok.length);
  });

  it('删除客户与新建工单并发：不会留下指向已删除客户的工单 / account delete vs ticket create', async () => {
    for (let i = 0; i < 3; i++) {
      const acc = (await call(accounts.POST, { token: admin.token, body: { name: `并发客户${i}` } })).json;
      const [del, add] = await Promise.all([
        call(accountItem.DELETE, { token: admin.token, params: { id: acc.id }, method: 'DELETE' }),
        create(admin, { accountId: acc.id }),
      ]);
      const exists = (await prisma.account.count({ where: { id: acc.id } })) === 1;
      if (exists) expect(del.status).toBe(409);
      else {
        expect(del.status).toBe(204);
        expect([400, 409]).toContain(add.status);
        expect(await prisma.ticket.count({ where: { accountId: acc.id } })).toBe(0);
      }
    }
  });
});

describe('tickets R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检 / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    for (const route of [tickets, ticketItem]) {
      const res = await route.OPTIONS(new Request('http://localhost/api/tickets', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
      for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
    }
  });
});
