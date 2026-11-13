/**
 * 已知问题修复 第一轮：功能测试（删除标签时清理视图中的标签筛选；演示标签固定 ID，重置后按标签筛选的视图仍有效；重置清理失效的标签筛选）。
 * Known-issue fixes round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ORG_NAME, DEMO_TAGS, demoTagId } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as leadTags from '@/app/api/leads/[id]/tags/route';
import * as leads from '@/app/api/leads/route';
import * as tagItem from '@/app/api/tags/[id]/route';
import * as tags from '@/app/api/tags/route';
import * as views from '@/app/api/views/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

beforeEach(async () => {
  await resetDb();
});

describe('cleanup R1 tag deletion', () => {
  it('删除标签：所有用户的私有与共享视图去掉该标签筛选，其他条件保留，审计记录数量 / views lose only the deleted tag', async () => {
    const a = await createTenant('A');
    const other = await addUser(a.org.id, 'SALES', '乙');
    const t1 = (await call(tags.POST, { token: a.token, body: { name: '将删除' } })).json;
    const t2 = (await call(tags.POST, { token: a.token, body: { name: '保留' } })).json;
    const shared = (await call(views.POST, { token: a.token, body: { entity: 'leads', name: '共享', shared: true, filters: { tagId: t1.id, status: 'NEW' } } })).json;
    const mine = (await call(views.POST, { token: other.token, body: { entity: 'accounts', name: '私有', filters: { tagId: t1.id, q: '甲' } } })).json;
    const untouched = (await call(views.POST, { token: a.token, body: { entity: 'deals', name: '其他标签', filters: { tagId: t2.id } } })).json;
    expect((await call(tagItem.DELETE, { token: a.token, method: 'DELETE', params: { id: t1.id } })).status).toBe(204);
    const byId = async (id: string) => (await prisma.savedView.findUniqueOrThrow({ where: { id } })).filters;
    expect(await byId(shared.id)).toEqual({ status: 'NEW' });
    expect(await byId(mine.id)).toEqual({ q: '甲' });
    expect(await byId(untouched.id)).toEqual({ tagId: t2.id });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tag.delete', entityId: t1.id } });
    expect(log.changes).toMatchObject({ views: 2 });
  });

  it('清理后的视图套用时返回正常结果而不是空列表 / a cleaned view no longer yields an empty list', async () => {
    const a = await createTenant('A');
    const t1 = (await call(tags.POST, { token: a.token, body: { name: '临时' } })).json;
    const lead = (await call(leads.POST, { token: a.token, body: { name: '视图线索' } })).json;
    await call(leadTags.PUT, { token: a.token, method: 'PUT', params: { id: lead.id }, body: { tagIds: [t1.id] } });
    const v = (await call(views.POST, { token: a.token, body: { entity: 'leads', name: '按标签', filters: { tagId: t1.id, q: '视图' } } })).json;
    await call(tagItem.DELETE, { token: a.token, method: 'DELETE', params: { id: t1.id } });
    const filters = (await call(views.GET, { token: a.token, query: { entity: 'leads' } })).json.items.find((x: { id: string }) => x.id === v.id).filters;
    expect(filters).toEqual({ q: '视图' });
    expect((await call(leads.GET, { token: a.token, query: filters })).json.total).toBe(1);
  });
});

describe('cleanup R1 demo reset', () => {
  it('演示标签 ID 固定：两次重置后相同，按演示标签筛选的视图仍有效 / stable demo tag ids across resets', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const key = DEMO_TAGS.find((x) => x.key === 'key')!;
    const before = await prisma.tag.findFirstOrThrow({ where: { organizationId: org.id, name: key.name } });
    expect(before.id).toBe(demoTagId(org.id, 'key'));
    const admin = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'ADMIN' } });
    const view = await prisma.savedView.create({ data: { organizationId: org.id, ownerId: admin.id, entity: 'accounts', name: '重点客户', filters: { tagId: before.id } } });
    await seedDemo({ reset: true });
    const after = await prisma.tag.findFirstOrThrow({ where: { organizationId: org.id, name: key.name } });
    expect(after.id).toBe(before.id);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })).filters).toEqual({ tagId: before.id });
    expect(await prisma.accountTag.count({ where: { tagId: after.id } })).toBeGreaterThan(0);
  });

  it('重置时清理指向已不存在标签的视图筛选，其他视图不变 / the reset drops stale tag filters only', async () => {
    await seedDemo();
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const admin = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, role: 'ADMIN' } });
    const custom = await prisma.tag.create({ data: { organizationId: org.id, name: '用户自建', nameKey: '用户自建' } });
    const stale = await prisma.savedView.create({ data: { organizationId: org.id, ownerId: admin.id, entity: 'leads', name: '自建标签视图', filters: { tagId: custom.id, status: 'NEW' } } });
    const plain = await prisma.savedView.create({ data: { organizationId: org.id, ownerId: admin.id, entity: 'leads', name: '普通视图', filters: { source: 'WEBSITE' } } });
    await seedDemo({ reset: true });
    expect(await prisma.tag.count({ where: { id: custom.id } })).toBe(0);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: stale.id } })).filters).toEqual({ status: 'NEW' });
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: plain.id } })).filters).toEqual({ source: 'WEBSITE' });
  });
});
