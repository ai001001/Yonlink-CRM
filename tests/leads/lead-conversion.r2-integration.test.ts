/**
 * 线索转化 第二轮：集成测试（重复/并发转化、事务回滚、异常输入、关联删除、组织隔离、数据库约束）。
 * Lead conversion round 2: integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  b = await createTenant('B');
});

const mkLead = async (token: string, body: object = { name: '张三', company: '星河' }) => (await call(leads.POST, { token, body })).json;
const doConvert = (token: string, id: string, body: object) => call(convert.POST, { token, params: { id }, body });
const counts = async () => ({ accounts: await prisma.account.count(), contacts: await prisma.contact.count(), deals: await prisma.deal.count() });

describe('lead conversion R2 repeat & concurrency', () => {
  it('重复转化 → 409，不产生多余记录 / second conversion is 409 without side effects', async () => {
    const lead = await mkLead(a.token);
    expect((await doConvert(a.token, lead.id, { account: { mode: 'new' }, deal: { name: 'd' } })).status).toBe(200);
    const res = await doConvert(a.token, lead.id, { account: { mode: 'new' }, deal: { name: 'd' } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('CONFLICT');
    expect(await counts()).toEqual({ accounts: 1, contacts: 1, deals: 1 });
  });

  it('并发转化同一线索只成功一次，失败方事务完整回滚 / concurrent conversions: one wins, loser fully rolls back', async () => {
    const lead = await mkLead(a.token);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => doConvert(a.token, lead.id, { account: { mode: 'new' }, deal: { name: 'd' } })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await counts()).toEqual({ accounts: 1, contacts: 1, deals: 1 });
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const winner = results.find((r) => r.status === 200)!.json;
    expect(row.convertedAccountId).toBe(winner.account.id);
  });
});

describe('lead conversion R2 invalid input', () => {
  it.each([
    ['缺少 account / missing account', {}],
    ['非法模式 / bad mode', { account: { mode: 'merge' } }],
    ['已有客户缺 id / existing without id', { account: { mode: 'existing' } }],
    ['已有客户 id 非 UUID / bad uuid', { account: { mode: 'existing', accountId: 'x' } }],
    ['新客户名为空白 / blank name', { account: { mode: 'new', name: '  ' } }],
    ['新客户名超长 / name too long', { account: { mode: 'new', name: 'x'.repeat(201) } }],
    ['商机缺名称 / deal without name', { account: { mode: 'new' }, deal: {} }],
    ['商机金额非法 / bad amount', { account: { mode: 'new' }, deal: { name: 'd', amount: '-1' } }],
    ['商机阶段非法 / bad stage', { account: { mode: 'new' }, deal: { name: 'd', stage: 'WON' } }],
    ['商机日期非法 / bad date', { account: { mode: 'new' }, deal: { name: 'd', expectedCloseDate: '2027-02-30' } }],
    ['未知字段 / unknown field', { account: { mode: 'new' }, organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['联系人字段注入 / contact injection', { account: { mode: 'new' }, contact: { name: 'x' } }],
  ])('%s → 400 且无任何写入', async (_label, body) => {
    const lead = await mkLead(a.token);
    const res = await doConvert(a.token, lead.id, body);
    expect(res.status).toBe(400);
    expect(await counts()).toEqual({ accounts: 0, contacts: 0, deals: 0 });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('NEW');
  });

  it('已有客户不存在 → 400，事务回滚 / unknown existing account → 400, rolled back', async () => {
    const lead = await mkLead(a.token);
    const res = await doConvert(a.token, lead.id, { account: { mode: 'existing', accountId: '00000000-0000-4000-8000-000000000000' } });
    expect(res.status).toBe(400);
    expect(res.json.error.details['account.accountId']).toBeDefined();
    expect(await counts()).toEqual({ accounts: 0, contacts: 0, deals: 0 });
  });

  it('不能通过新建或编辑把状态设为“已转化” / CONVERTED cannot be set via create or update', async () => {
    expect((await call(leads.POST, { token: a.token, body: { name: 'x', status: 'CONVERTED' } })).status).toBe(400);
    const lead = await mkLead(a.token);
    expect((await call(leadItem.PATCH, { token: a.token, method: 'PATCH', params: { id: lead.id }, body: { status: 'CONVERTED' } })).status).toBe(400);
  });

  it('已转化线索不能改状态（409）/ converted lead status is locked', async () => {
    const lead = await mkLead(a.token);
    await doConvert(a.token, lead.id, { account: { mode: 'new' } });
    const res = await call(leadItem.PATCH, { token: a.token, method: 'PATCH', params: { id: lead.id }, body: { status: 'NEW' } });
    expect(res.status).toBe(409);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('CONVERTED');
  });

  it('非法线索 id → 404 / malformed or unknown lead id → 404', async () => {
    expect((await doConvert(a.token, 'abc', { account: { mode: 'new' } })).status).toBe(404);
    expect((await doConvert(a.token, '00000000-0000-4000-8000-000000000000', { account: { mode: 'new' } })).status).toBe(404);
  });
});

describe('lead conversion R2 relations after conversion', () => {
  it('删除转化出的商机/客户后，线索仍为已转化且链接置空 / deleting results nulls the links', async () => {
    const lead = await mkLead(a.token);
    const res = (await doConvert(a.token, lead.id, { account: { mode: 'new' }, deal: { name: 'd' } })).json;
    expect((await call(dealItem.DELETE, { token: a.token, method: 'DELETE', params: { id: res.deal.id } })).status).toBe(204);
    expect((await call(accountItem.DELETE, { token: a.token, method: 'DELETE', params: { id: res.account.id } })).status).toBe(204);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row).toMatchObject({ status: 'CONVERTED', convertedAccountId: null, convertedContactId: null, convertedDealId: null });
    expect(row.convertedAt).not.toBeNull();
  });

  it('删除已转化线索不影响客户、联系人、商机 / deleting the lead keeps converted records', async () => {
    const lead = await mkLead(a.token);
    await doConvert(a.token, lead.id, { account: { mode: 'new' }, deal: { name: 'd' } });
    expect((await call(leadItem.DELETE, { token: a.token, method: 'DELETE', params: { id: lead.id } })).status).toBe(204);
    expect(await counts()).toEqual({ accounts: 1, contacts: 1, deals: 1 });
  });
});

describe('lead conversion R2 organization isolation', () => {
  it('未登录 401 / unauthenticated', async () => {
    const lead = await mkLead(a.token);
    expect((await call(convert.POST, { params: { id: lead.id }, body: { account: { mode: 'new' } } })).status).toBe(401);
  });

  it('不能转化其他组织的线索（404，无写入）/ cannot convert another org lead', async () => {
    const lead = await mkLead(b.token);
    expect((await doConvert(a.token, lead.id, { account: { mode: 'new' } })).status).toBe(404);
    expect(await counts()).toEqual({ accounts: 0, contacts: 0, deals: 0 });
  });

  it('不能把线索转化到其他组织的客户（400）/ cannot convert into another org account', async () => {
    const accB = (await call(accounts.POST, { token: b.token, body: { name: 'B 客户' } })).json;
    const lead = await mkLead(a.token);
    expect((await doConvert(a.token, lead.id, { account: { mode: 'existing', accountId: accB.id } })).status).toBe(400);
    expect(await prisma.contact.count({ where: { accountId: accB.id } })).toBe(0);
  });

  it('转化产生的记录都属于当前组织 / created records belong to the caller org', async () => {
    const lead = await mkLead(a.token);
    await doConvert(a.token, lead.id, { account: { mode: 'new' }, deal: { name: 'd' } });
    for (const n of [
      await prisma.account.count({ where: { organizationId: { not: a.org.id } } }),
      await prisma.contact.count({ where: { organizationId: { not: a.org.id } } }),
      await prisma.deal.count({ where: { organizationId: { not: a.org.id } } }),
    ]) expect(n).toBe(0);
  });

  it('数据库触发器阻止跨组织转化链接 / DB trigger blocks cross-org links', async () => {
    const accB = (await call(accounts.POST, { token: b.token, body: { name: 'B' } })).json;
    const lead = await mkLead(a.token);
    // 触发器以外键错误码 23503 拒绝；Prisma 统一报告为外键约束错误
    // the trigger rejects with SQLSTATE 23503, which Prisma reports as a foreign key violation
    await expect(
      prisma.lead.update({ where: { id: lead.id }, data: { convertedAccountId: accB.id } }),
    ).rejects.toThrow(/Foreign key constraint/);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).convertedAccountId).toBeNull();
    // 同组织链接允许 / same-org link allowed (with consistent status)
    const accA = (await call(accounts.POST, { token: a.token, body: { name: 'A' } })).json;
    await expect(
      prisma.lead.update({ where: { id: lead.id }, data: { convertedAccountId: accA.id } }),
    ).resolves.toBeTruthy();
  });

  it('数据库 CHECK：已转化必须有转化时间，反之亦然 / DB CHECK keeps status and convertedAt consistent', async () => {
    const lead = await mkLead(a.token);
    await expect(prisma.lead.update({ where: { id: lead.id }, data: { status: 'CONVERTED' } })).rejects.toThrow();
    await expect(prisma.lead.update({ where: { id: lead.id }, data: { convertedAt: new Date() } })).rejects.toThrow();
  });
});
