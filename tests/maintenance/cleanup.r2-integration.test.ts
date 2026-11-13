/**
 * 已知问题修复 第二轮：集成测试（组织隔离、无权限删除不改视图、默认视图保留、固定 ID 合法且按组织区分）。
 * Known-issue fixes round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEMO_TAGS, demoTagId } from '../../prisma/demo-data';
import * as tagItem from '@/app/api/tags/[id]/route';
import * as tags from '@/app/api/tags/route';
import * as defaults from '@/app/api/views/default/route';
import * as views from '@/app/api/views/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let tag: { id: string };
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  tag = (await call(tags.POST, { token: a.token, body: { name: '标签' } })).json;
});

describe('cleanup R2', () => {
  it('删除本组织标签不改动其他组织的视图（即使筛选值相同）/ other organizations are untouched', async () => {
    const b = await createTenant('B');
    const foreign = (await call(views.POST, { token: b.token, body: { entity: 'leads', name: '他组织', filters: { tagId: tag.id } } })).json;
    await call(tagItem.DELETE, { token: a.token, method: 'DELETE', params: { id: tag.id } });
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: foreign.id } })).filters).toEqual({ tagId: tag.id });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tag.delete' } });
    expect(log.changes).toMatchObject({ views: 0 });
  });

  it('无权限删除失败时视图不变 / a refused delete changes nothing', async () => {
    const sales = await addUser(a.org.id, 'SALES');
    const v = (await call(views.POST, { token: sales.token, body: { entity: 'leads', name: '我的', filters: { tagId: tag.id } } })).json;
    expect((await call(tagItem.DELETE, { token: sales.token, method: 'DELETE', params: { id: tag.id } })).status).toBe(403);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: v.id } })).filters).toEqual({ tagId: tag.id });
    expect(await prisma.tag.count()).toBe(1);
  });

  it('视图仍存在，默认视图设置保留 / views and defaults survive', async () => {
    const v = (await call(views.POST, { token: a.token, body: { entity: 'leads', name: '默认', filters: { tagId: tag.id } } })).json;
    await call(defaults.PUT, { token: a.token, method: 'PUT', body: { entity: 'leads', viewId: v.id } });
    await call(tagItem.DELETE, { token: a.token, method: 'DELETE', params: { id: tag.id } });
    const r = (await call(views.GET, { token: a.token, query: { entity: 'leads' } })).json;
    expect(r.defaultViewId).toBe(v.id);
    expect(r.items[0].filters).toEqual({});
  });

  it('演示标签固定 ID：合法 UUID、可重复计算、按组织与标签区分 / stable ids are valid and distinct', () => {
    const org1 = '11111111-1111-4111-8111-111111111111';
    const org2 = '22222222-2222-4222-8222-222222222222';
    const ids = DEMO_TAGS.map((t) => demoTagId(org1, t.key));
    for (const id of ids) expect(z.uuid().safeParse(id).success, id).toBe(true);
    expect(new Set(ids).size).toBe(DEMO_TAGS.length);
    expect(demoTagId(org1, 'key')).toBe(demoTagId(org1, 'key'));
    expect(demoTagId(org2, 'key')).not.toBe(demoTagId(org1, 'key'));
  });
});
