/**
 * 附件 第二轮：集成测试（角色权限、改派后权限、组织隔离与存储隔离、异常请求、数据库约束、存储安全与完整性）。
 * Attachments round 2: integration tests.
 */
import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as attachmentItem from '@/app/api/attachments/[id]/route';
import * as attachments from '@/app/api/attachments/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import { prisma } from '@/server/db';
import { attachmentsRoot, saveFile } from '@/server/storage';
import { addUser, call, createTenant, resetDb } from '../helpers';
import { diskPath, fetchFile, onDisk, SAMPLES, upload } from './files';

type Who = { user: { id: string }; token: string };
let admin: Awaited<ReturnType<typeof createTenant>>;
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let lead1: { id: string };
let lead2: { id: string };
const remove = (who: { token: string }, id: string) => call(attachmentItem.DELETE, { token: who.token, method: 'DELETE', params: { id } });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  lead1 = (await call(leads.POST, { token: sales1.token, body: { name: '销售1线索' } })).json;
  lead2 = (await call(leads.POST, { token: sales2.token, body: { name: '销售2线索' } })).json;
});

describe('attachments R2 permissions', () => {
  it('上传：本人记录 201、他人记录 404、只读 403、经理 201 / upload rights', async () => {
    expect((await upload(sales1.token, { leadId: lead1.id }, 'a.txt', 'a')).status).toBe(201);
    expect((await upload(sales1.token, { leadId: lead2.id }, 'a.txt', 'a')).status).toBe(404);
    expect((await upload(viewer.token, { leadId: lead1.id }, 'a.txt', 'a')).status).toBe(403);
    expect((await upload(manager.token, { leadId: lead1.id }, 'b.txt', 'b')).status).toBe(201);
  });

  it('查看与下载遵循记录可见范围 / viewing and downloading follow visibility', async () => {
    const x = (await upload(sales1.token, { leadId: lead1.id }, 'a.txt', 'secret')).json;
    expect((await fetchFile(sales2.token, x.id)).status).toBe(404);
    expect((await call(attachments.GET, { token: sales2.token, query: { leadId: lead1.id } })).status).toBe(404);
    expect((await fetchFile(viewer.token, x.id)).status).toBe(200);
    expect((await call(attachments.GET, { token: viewer.token, query: { leadId: lead1.id } })).json.items).toHaveLength(1);
  });

  it('删除：上传人可以；不能删他人上传的；只读 403；经理可删任意 / delete rules', async () => {
    const own = (await upload(sales1.token, { leadId: lead1.id }, 'own.txt', 'a')).json;
    const byManager = (await upload(manager.token, { leadId: lead1.id }, 'mgr.txt', 'b')).json;
    expect((await remove(sales1, byManager.id)).status).toBe(403);
    expect((await remove(viewer, own.id)).status).toBe(403);
    expect((await remove(sales1, own.id)).status).toBe(204);
    expect((await remove(manager, byManager.id)).status).toBe(204);
  });

  it('记录改派后：原负责人看不到也删不了自己上传的附件 / reassignment moves access', async () => {
    const x = (await upload(sales1.token, { leadId: lead1.id }, 'a.txt', 'a')).json;
    await call(leadItem.PATCH, { token: manager.token, method: 'PATCH', params: { id: lead1.id }, body: { ownerId: sales2.user.id } });
    expect((await remove(sales1, x.id)).status).toBe(404);
    expect((await fetchFile(sales2.token, x.id)).status).toBe(200);
  });
});

describe('attachments R2 isolation & input', () => {
  it('跨组织：看不到、下载不了、删不了、不能上传到他组织记录；文件按组织目录隔离 / cross-org isolation', async () => {
    const x = (await upload(admin.token, { leadId: lead1.id }, 'a.txt', 'a')).json;
    const other = await createTenant('B', 'ADMIN');
    expect((await fetchFile(other.token, x.id)).status).toBe(404);
    expect((await remove(other, x.id)).status).toBe(404);
    expect((await call(attachments.GET, { token: other.token, query: { leadId: lead1.id } })).status).toBe(404);
    expect((await upload(other.token, { leadId: lead1.id }, 'b.txt', 'b')).status).toBe(404);
    const bLead = (await call(leads.POST, { token: other.token, body: { name: 'B 线索' } })).json;
    const y = (await upload(other.token, { leadId: bLead.id }, 'b.txt', 'b')).json;
    expect(onDisk(other.org.id, y.id)).toBe(true);
    expect(onDisk(admin.org.id, y.id)).toBe(false);
    expect(diskPath(other.org.id, y.id).startsWith(attachmentsRoot())).toBe(true);
  });

  it.each([
    [{}, 'no parent'],
    [{ leadId: 'x' }, 'bad uuid'],
    [{ organizationId: '00000000-0000-4000-8000-000000000000' }, 'client organization id'],
  ])('非法所属记录 %j（%s）→ 400 / invalid parents', async (fields, label) => {
    const r = await upload(admin.token, {}, 'a.txt', 'a', fields as Record<string, string>);
    expect(r.status, label).toBe(400);
  });

  it('同时指定两个所属记录、缺少文件、非 multipart、Content-Length 过大 / malformed requests', async () => {
    const acc = (await call((await import('@/app/api/accounts/route')).POST, { token: admin.token, body: { name: '客户' } })).json;
    expect((await upload(admin.token, { leadId: lead1.id, accountId: acc.id }, 'a.txt', 'a')).status).toBe(400);
    const route = { params: Promise.resolve({}) };
    const noFile = new FormData();
    noFile.append('leadId', lead1.id);
    const r1 = await attachments.POST(new Request('http://localhost/api/attachments', { method: 'POST', headers: { authorization: `Bearer ${admin.token}` }, body: noFile }), route);
    expect(r1.status).toBe(400);
    const r2 = await attachments.POST(
      new Request('http://localhost/api/attachments', { method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ leadId: lead1.id }) }),
      route,
    );
    expect(r2.status).toBe(400);
    const r3 = await attachments.POST(
      new Request('http://localhost/api/attachments', { method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-length': String(50 * 1024 * 1024) }, body: noFile }),
      route,
    );
    expect(r3.status).toBe(413);
    expect((await call(attachments.GET, { token: admin.token, query: { leadId: lead1.id, accountId: acc.id } })).status).toBe(400);
  });

  it('未登录 401 / unauthenticated', async () => {
    const x = (await upload(admin.token, { leadId: lead1.id }, 'a.txt', 'a')).json;
    expect((await upload(undefined, { leadId: lead1.id }, 'a.txt', 'a')).status).toBe(401);
    expect((await fetchFile(undefined, x.id)).status).toBe(401);
    expect((await call(attachments.GET, { query: { leadId: lead1.id } })).status).toBe(401);
  });

  it('数据库约束：恰好一个所属记录、大小范围、SHA 格式、跨组织所属记录 / DB constraints', async () => {
    const base = { organizationId: admin.org.id, fileName: 'x.txt', contentType: 'text/plain', size: 1, sha256: 'a'.repeat(64), uploadedById: admin.user.id };
    await expect(prisma.attachment.create({ data: { ...base } })).rejects.toThrow();
    await expect(prisma.attachment.create({ data: { ...base, leadId: lead1.id, size: 10 * 1024 * 1024 + 1 } })).rejects.toThrow();
    await expect(prisma.attachment.create({ data: { ...base, leadId: lead1.id, sha256: 'Z'.repeat(64) } })).rejects.toThrow();
    const other = await createTenant('B', 'ADMIN');
    await expect(prisma.attachment.create({ data: { ...base, organizationId: other.org.id, uploadedById: other.user.id, leadId: lead1.id } })).rejects.toThrow();
  });
});

describe('attachments R2 storage safety', () => {
  it('生产环境未配置附件目录时直接报错；存储键必须是 UUID / production requires ATTACHMENTS_DIR; keys must be UUIDs', async () => {
    const saved = { dir: process.env.ATTACHMENTS_DIR, env: process.env.NODE_ENV };
    try {
      delete process.env.ATTACHMENTS_DIR;
      (process.env as Record<string, string>).NODE_ENV = 'production';
      expect(() => attachmentsRoot()).toThrow();
    } finally {
      process.env.ATTACHMENTS_DIR = saved.dir;
      (process.env as Record<string, string | undefined>).NODE_ENV = saved.env;
    }
    await expect(saveFile(admin.org.id, '../../etc/passwd', new Uint8Array([1]))).rejects.toThrow();
    await expect(saveFile('../x', '00000000-0000-4000-8000-000000000000', new Uint8Array([1]))).rejects.toThrow();
  });

  it('文件被篡改时下载 500，文件丢失时 404 / tampered files fail, missing files 404', async () => {
    const x = (await upload(admin.token, { leadId: lead1.id }, 'a.pdf', SAMPLES.pdf)).json;
    writeFileSync(diskPath(admin.org.id, x.id), 'tampered');
    expect((await fetchFile(admin.token, x.id)).status).toBe(500);
    const y = (await upload(admin.token, { leadId: lead1.id }, 'b.txt', 'b')).json;
    const { rmSync } = await import('node:fs');
    rmSync(diskPath(admin.org.id, y.id));
    expect((await fetchFile(admin.token, y.id)).status).toBe(404);
  });
});
