/**
 * 市场活动 第二轮：集成测试（管理权限、销售代表的统计与明细只含自己的、销售可关联自己的线索、跨组织隔离、
 * 参数校验、同名并发新建、删除与关联并发、未登录、跨域预检）。
 * Campaigns round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as campaignItem from '@/app/api/campaigns/[id]/route';
import * as campaignOptions from '@/app/api/campaigns/options/route';
import * as campaigns from '@/app/api/campaigns/route';
import * as leads from '@/app/api/leads/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let sales2: Who;
let viewer: Who;
let camp: { id: string };

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  sales2 = await addUser(admin.org.id, 'SALES', 'S2');
  viewer = await addUser(admin.org.id, 'READONLY');
  camp = (await call(campaigns.POST, { token: admin.token, body: { name: '展会', type: 'EXHIBITION' } })).json;
});

describe('campaigns R2 permissions & scope', () => {
  it('管理员、经理可管理；销售、只读只能查看 / manage permission', async () => {
    expect((await call(campaigns.POST, { token: manager.token, body: { name: '经理活动', type: 'EMAIL' } })).status).toBe(201);
    for (const who of [sales1, viewer]) {
      expect((await call(campaigns.GET, { token: who.token })).status).toBe(200);
      expect((await call(campaignItem.GET, { token: who.token, params: { id: camp.id } })).status).toBe(200);
      expect((await call(campaigns.POST, { token: who.token, body: { name: '越权', type: 'EMAIL' } })).status).toBe(403);
      expect((await call(campaignItem.PATCH, { token: who.token, params: { id: camp.id }, body: { status: 'CANCELLED' }, method: 'PATCH' })).status).toBe(403);
      expect((await call(campaignItem.DELETE, { token: who.token, params: { id: camp.id }, method: 'DELETE' })).status).toBe(403);
    }
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } })).status).toBe('PLANNED');
  });

  it('销售可把自己的线索关联到活动；统计与明细只含自己的 / sales see their own', async () => {
    expect((await call(leads.POST, { token: sales1.token, body: { name: '销售1线索', campaignId: camp.id } })).status).toBe(201);
    await call(leads.POST, { token: sales2.token, body: { name: '销售2线索', campaignId: camp.id } });
    const mine = (await call(campaignItem.GET, { token: sales1.token, params: { id: camp.id } })).json;
    expect(mine.stats.leads).toBe(1);
    expect(mine.leads.map((l: { name: string }) => l.name)).toEqual(['销售1线索']);
    const all = (await call(campaignItem.GET, { token: manager.token, params: { id: camp.id } })).json;
    expect(all.stats.leads).toBe(2);
    expect((await call(campaigns.GET, { token: sales1.token })).json.items[0].stats.leads).toBe(1);
    // 删除限制按全部记录计（销售看不到的也算）/ the delete guard counts all records
    expect((await call(campaignItem.DELETE, { token: admin.token, params: { id: camp.id }, method: 'DELETE' })).status).toBe(409);
  });

  it('跨组织隔离 / cross-tenant isolation', async () => {
    expect((await call(campaigns.GET, { token: other.token })).json.total).toBe(0);
    expect((await call(campaignOptions.GET, { token: other.token, query: { include: camp.id } })).json.items).toEqual([]);
    expect((await call(campaignItem.GET, { token: other.token, params: { id: camp.id } })).status).toBe(404);
    expect((await call(campaignItem.PATCH, { token: other.token, params: { id: camp.id }, body: { name: 'x' }, method: 'PATCH' })).status).toBe(404);
    expect((await call(campaignItem.DELETE, { token: other.token, params: { id: camp.id }, method: 'DELETE' })).status).toBe(404);
    // 同名在不同组织互不冲突 / names are unique per organization only
    expect((await call(campaigns.POST, { token: other.token, body: { name: '展会', type: 'EXHIBITION' } })).status).toBe(201);
  });
});

describe('campaigns R2 validation & concurrency', () => {
  it('参数校验与未登录 / validation and auth', async () => {
    const bad = [
      {},
      { name: 'x', type: 'TV' },
      { name: ' ', type: 'EMAIL' },
      { name: 'x'.repeat(101), type: 'EMAIL' },
      { name: 'x', type: 'EMAIL', budget: '-1' },
      { name: 'x', type: 'EMAIL', actualCost: 'abc' },
      { name: 'x', type: 'EMAIL', currency: 'GBP' },
      { name: 'x', type: 'EMAIL', status: 'DONE' },
      { name: 'x', type: 'EMAIL', startDate: '2026-02-30' },
      { name: 'x', type: 'EMAIL', organizationId: other.org.id },
      { name: 'x', type: 'EMAIL', ownerId: other.user.id },
    ];
    for (const body of bad) expect((await call(campaigns.POST, { token: admin.token, body })).status).toBe(400);
    for (const query of [{ status: 'X' }, { type: 'X' }, { pageSize: '101' }] as Record<string, string>[]) expect((await call(campaigns.GET, { token: admin.token, query })).status).toBe(400);
    expect((await call(campaignOptions.GET, { token: admin.token, query: { include: 'x' } })).status).toBe(400);
    expect((await call(campaigns.GET)).status).toBe(401);
    expect(await prisma.campaign.count()).toBe(1);
  });

  it('同名并发新建只成功一个 / concurrent same-name creation', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => call(campaigns.POST, { token: admin.token, body: { name: '并发活动', type: 'EMAIL' } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await prisma.campaign.count({ where: { name: '并发活动' } })).toBe(1);
  });

  it('删除与关联并发：不会留下指向已删除活动的线索 / delete vs link', async () => {
    const [del, link] = await Promise.all([
      call(campaignItem.DELETE, { token: admin.token, params: { id: camp.id }, method: 'DELETE' }),
      call(leads.POST, { token: manager.token, body: { name: '并发线索', campaignId: camp.id } }),
    ]);
    const exists = (await prisma.campaign.count({ where: { id: camp.id } })) === 1;
    const linked = await prisma.lead.count({ where: { campaignId: camp.id } });
    if (exists) expect(del.status).toBe(409);
    else {
      expect(del.status).toBe(204);
      expect(linked).toBe(0);
      expect([400, 409]).toContain(link.status);
    }
  });
});

describe('campaigns R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET/POST/PATCH/DELETE / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await campaignItem.OPTIONS(new Request('http://localhost/api/campaigns/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
  });
});
