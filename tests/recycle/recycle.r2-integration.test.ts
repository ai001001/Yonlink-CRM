/**
 * 回收站 第二轮：集成测试（角色权限、组织隔离、快照中的组织 ID 不可信、并发恢复、恢复后再删除、负责人可见性、异常输入）。
 * Recycle bin round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as binItem from '@/app/api/recycle-bin/[id]/route';
import * as restoreRoute from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales: Who;
let viewer: Who;
let lead: { id: string };
let itemId: string;

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales = await addUser(admin.org.id, 'SALES');
  viewer = await addUser(admin.org.id, 'READONLY');
  lead = (await call(leads.POST, { token: sales.token, body: { name: '销售的线索' } })).json;
  await call(leadItem.DELETE, { token: manager.token, method: 'DELETE', params: { id: lead.id } });
  itemId = (await prisma.recycleBinItem.findFirstOrThrow()).id;
});

const restore = (who: { token: string }, id = itemId) => call(restoreRoute.POST, { token: who.token, params: { id } });
const purge = (who: { token: string }, id = itemId) => call(binItem.DELETE, { token: who.token, method: 'DELETE', params: { id } });

describe('recycle R2 permissions', () => {
  it('销售代表与只读：不能查看、恢复、彻底删除、清空（403）/ sales and read-only are refused', async () => {
    for (const who of [sales, viewer]) {
      expect((await call(bin.GET, { token: who.token })).status).toBe(403);
      expect((await restore(who)).status).toBe(403);
      expect((await purge(who)).status).toBe(403);
      expect((await call(bin.DELETE, { token: who.token, method: 'DELETE' })).status).toBe(403);
    }
    expect(await prisma.recycleBinItem.count()).toBe(1);
  });

  it('经理：可查看与恢复，不能彻底删除与清空 / managers restore but cannot purge', async () => {
    expect((await call(bin.GET, { token: manager.token })).json.items).toHaveLength(1);
    expect((await purge(manager)).status).toBe(403);
    expect((await call(bin.DELETE, { token: manager.token, method: 'DELETE' })).status).toBe(403);
    expect((await restore(manager)).status).toBe(200);
  });

  it('恢复后保持原负责人：销售代表重新看到自己的线索 / the owner sees the restored lead again', async () => {
    expect((await call(leadItem.GET, { token: sales.token, params: { id: lead.id } })).status).toBe(404);
    await restore(admin);
    const r = await call(leadItem.GET, { token: sales.token, params: { id: lead.id } });
    expect(r.status).toBe(200);
    expect(r.json.ownerId).toBe(sales.user.id);
  });
});

describe('recycle R2 isolation & robustness', () => {
  it('跨组织：看不到、不能恢复或彻底删除他组织的条目 / cross-org isolation', async () => {
    const other = await createTenant('B', 'ADMIN');
    expect((await call(bin.GET, { token: other.token })).json.items).toHaveLength(0);
    expect((await restore(other)).status).toBe(404);
    expect((await purge(other)).status).toBe(404);
    expect((await call(bin.DELETE, { token: other.token, method: 'DELETE' })).json).toEqual({ purged: 0 });
    expect(await prisma.recycleBinItem.count()).toBe(1);
  });

  it('快照中的组织 ID 不可信：恢复时一律写入当前组织 / the snapshot organization id is never trusted', async () => {
    const other = await createTenant('B', 'ADMIN');
    const item = await prisma.recycleBinItem.findUniqueOrThrow({ where: { id: itemId } });
    const payload = item.payload as { record: Record<string, unknown> };
    payload.record.organizationId = other.org.id;
    await prisma.recycleBinItem.update({ where: { id: itemId }, data: { payload: payload as never } });
    expect((await restore(admin)).status).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).organizationId).toBe(admin.org.id);
  });

  it('并发恢复同一条目：只成功一次 / concurrent restores succeed once', async () => {
    const res = await Promise.all([restore(admin), restore(manager)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await prisma.lead.count({ where: { id: lead.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'lead.restore' } })).toBe(1);
  });

  it('恢复后再次删除：重新进入回收站 / delete again after a restore', async () => {
    await restore(admin);
    expect((await call(leadItem.DELETE, { token: admin.token, method: 'DELETE', params: { id: lead.id } })).status).toBe(204);
    const items = (await call(bin.GET, { token: admin.token })).json.items;
    expect(items).toHaveLength(1);
    expect(items[0].entityId).toBe(lead.id);
    expect(items[0].id).not.toBe(itemId);
  });

  it('删除审计标记已放入回收站；恢复后审计记录名称 / audit details', async () => {
    const del = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.delete' } });
    expect(del.changes).toMatchObject({ recycled: true, before: { name: '销售的线索' } });
    await restore(admin);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.restore' } });
    expect(log.changes).toMatchObject({ name: '销售的线索', skipped: [] });
  });

  it('非法参数与未登录 / invalid input and authentication', async () => {
    expect((await call(bin.GET, { token: admin.token, query: { entityType: 'contact' } })).status).toBe(400);
    expect((await call(bin.GET, { token: admin.token, query: { page: '2' } })).status).toBe(400);
    expect((await restore(admin, 'not-a-uuid')).status).toBe(404);
    expect((await restore(admin, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await call(bin.GET)).status).toBe(401);
    expect((await call(restoreRoute.POST, { params: { id: itemId } })).status).toBe(401);
  });
});
