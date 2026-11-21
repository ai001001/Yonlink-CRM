/**
 * 自定义字段 第二轮：集成测试（已有 29 个时 3 个并发新建只成功 1 个；组织隔离（他组织的键不能用、删除只影响本组织）；
 * 数据库约束；删除商机后从回收站恢复保留自定义值；演示字段的值都能通过校验；2000 条记录时删除字段耗时）。
 * Custom fields round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_CUSTOM_FIELDS, DEMO_ORG_NAME } from '../../prisma/demo-data';
import { seedDemo } from '../../prisma/seed-demo';
import * as accounts from '@/app/api/accounts/route';
import * as fieldItem from '@/app/api/custom-fields/[id]/route';
import * as fields from '@/app/api/custom-fields/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leads from '@/app/api/leads/route';
import * as restore from '@/app/api/recycle-bin/[id]/restore/route';
import * as bin from '@/app/api/recycle-bin/route';
import { prisma } from '@/server/db';
import { normalize } from '@/server/modules/custom-fields';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
const newField = (body: object, t = a) => call(fields.POST, { token: t.token, body: { entity: 'LEAD', label: `字段${Math.random()}`, type: 'TEXT', ...body } });

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

describe('custom fields R2', () => {
  it('已有 29 个时 3 个并发新建：只成功 1 个 / the cap holds under concurrency', async () => {
    await prisma.customField.createMany({ data: Array.from({ length: 29 }, (_, i) => ({ organizationId: a.org.id, entity: 'LEAD' as const, key: `cf_${String(i).padStart(8, '0')}`, label: `f${i}`, type: 'TEXT' as const, position: i })) });
    const res = await Promise.all([newField({}), newField({}), newField({})]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.customField.count({ where: { organizationId: a.org.id } })).toBe(30);
  });

  it('组织隔离；数据库约束 / isolation and constraints', async () => {
    const b = await createTenant('B');
    const f = (await newField({ label: '等级' })).json;
    expect((await call(leads.POST, { token: b.token, body: { name: 'B', custom: { [f.key]: 'x' } } })).json.error.details).toEqual({ [`custom.${f.key}`]: ['unknown_field'] });
    expect((await call(fields.GET, { token: b.token })).json.items).toEqual([]);
    expect((await call(fieldItem.DELETE, { token: b.token, params: { id: f.id }, method: 'DELETE' })).status).toBe(404);
    // B 的记录里有同名键：A 删除字段不影响 B / B's records with the same key are untouched by A's delete
    const bLead = await prisma.lead.create({ data: { organizationId: b.org.id, name: 'B 线索', custom: { [f.key]: '保留' } } });
    await call(leads.POST, { token: a.token, body: { name: 'A 线索', custom: { [f.key]: '清除' } } });
    expect((await call(fieldItem.DELETE, { token: a.token, params: { id: f.id }, method: 'DELETE' })).json).toEqual({ cleared: 1 });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: bLead.id } })).custom).toEqual({ [f.key]: '保留' });
    // 约束 / constraints
    await expect(prisma.$executeRaw`UPDATE leads SET custom = '[]'::jsonb WHERE id = ${bLead.id}::uuid`).rejects.toThrow(/leads_custom_check/);
    await expect(prisma.customField.create({ data: { organizationId: a.org.id, entity: 'LEAD', key: 'bad_key', label: 'x', type: 'TEXT', position: 0 } })).rejects.toThrow(/custom_fields_check/);
    await expect(prisma.customField.create({ data: { organizationId: a.org.id, entity: 'LEAD', key: 'cf_aaaaaaaa', label: 'x', type: 'PICKLIST', position: 0 } })).rejects.toThrow(/custom_fields_check/);
    await expect(prisma.customField.create({ data: { organizationId: a.org.id, entity: 'LEAD', key: 'cf_aaaaaaab', label: 'y', type: 'TEXT', options: ['a'], position: 0 } })).rejects.toThrow(/custom_fields_check/);
  });

  it('回收站恢复保留自定义值 / restores keep custom values', async () => {
    const f = (await newField({ entity: 'DEAL', label: '交付', type: 'PICKLIST', options: ['海运'] })).json;
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: a.token, body: { name: '商机', accountId: acc.id, custom: { [f.key]: '海运' } } })).json;
    expect((await call(dealItem.DELETE, { token: a.token, params: { id: deal.id }, method: 'DELETE' })).status).toBe(204);
    const item = (await call(bin.GET, { token: a.token, query: { entityType: 'deal' } })).json.items[0];
    expect((await call(restore.POST, { token: a.token, params: { id: item.id } })).status).toBe(200);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).custom).toEqual({ [f.key]: '海运' });
  });

  it('2000 条记录：删除字段 3 秒内并清除全部值 / deleting a field with 2000 records', async () => {
    const f = (await newField({ label: '批量' })).json;
    await prisma.lead.createMany({ data: Array.from({ length: 2000 }, (_, i) => ({ organizationId: a.org.id, name: `L${i}`, custom: { [f.key]: `v${i}` } })) });
    const t0 = Date.now();
    expect((await call(fieldItem.DELETE, { token: a.token, params: { id: f.id }, method: 'DELETE' })).json).toEqual({ cleared: 2000 });
    expect(Date.now() - t0).toBeLessThan(3000);
    const [left] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM leads WHERE organization_id = ${a.org.id}::uuid AND custom ? ${f.key}`;
    expect(left!.n).toBe(0);
  });

  it('演示数据：字段定义与每条记录的值都能通过校验 / demo data', async () => {
    await seedDemo({ reset: true });
    const org = await prisma.organization.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    const defs = await prisma.customField.findMany({ where: { organizationId: org.id }, orderBy: { position: 'asc' } });
    expect(defs.map((d) => [d.entity, d.label, d.type])).toEqual(DEMO_CUSTOM_FIELDS.map((d) => [d.entity, d.label, d.type]));
    for (const d of defs) {
      const table = { LEAD: prisma.lead, ACCOUNT: prisma.account, CONTACT: prisma.contact, DEAL: prisma.deal }[d.entity] as unknown as { findMany: (a: object) => Promise<{ custom: Record<string, unknown> }[]> };
      const rows = await table.findMany({ where: { organizationId: org.id }, select: { custom: true } });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(normalize(d, r.custom[d.key]), `${d.label}`).toEqual(r.custom[d.key]);
    }
  });
});

