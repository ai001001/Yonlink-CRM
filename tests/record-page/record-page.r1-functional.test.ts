/**
 * 整页详情 第一轮：功能测试（时间线接口：跟进、备注、修改记录按时间合并；分页不漏不重（含同一毫秒的条目）；
 * 跟进按查看者范围；记录不可见 404；区域只读范围可看；没有审计权限不返回 IP；参数校验；单字段修改写审计并出现在时间线）。
 * Full-page detail round 1: functional tests of the timeline API and single-field edits.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as activities from '@/app/api/activities/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as deals from '@/app/api/deals/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as leads from '@/app/api/leads/route';
import * as notes from '@/app/api/notes/route';
import * as territories from '@/app/api/territories/route';
import * as timeline from '@/app/api/timeline/route';
import { prisma } from '@/server/db';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let sales: Awaited<ReturnType<typeof addUser>>;

type Item = { kind: string; id: string; at: string; entry?: { action: string; ip: string | null } };
const page = (entity: string, id: string, token = a.token, extra: Record<string, string> = {}) => call(timeline.GET, { token, query: { entity, id, ...extra } });

/** 读取全部页 / read every page */
async function all(entity: string, id: string, token = a.token) {
  const out: Item[] = [];
  for (let i = 0; i < 20; i++) {
    const last = out[out.length - 1];
    const exclude = last ? out.filter((x) => x.at === last.at).map((x) => x.id).join(',') : '';
    const r = (await page(entity, id, token, last ? { before: last.at, exclude } : {})).json;
    out.push(...r.items);
    if (!r.hasMore) break;
  }
  return out;
}

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  sales = await addUser(a.org.id, 'SALES', '销售');
});

describe('record page R1 timeline', () => {
  it('合并跟进、备注、修改记录，最新在前 / merges activities, notes and changes, newest first', async () => {
    const lead = (await call(leads.POST, { token: a.token, body: { name: '时间线线索' } })).json;
    await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '首次电话', leadId: lead.id } });
    await call(notes.POST, { token: a.token, body: { leadId: lead.id, content: '客户关注价格' } });
    await call(leadItem.PATCH, { token: a.token, params: { id: lead.id }, body: { company: '甲公司' }, method: 'PATCH' });
    const items = (await page('lead', lead.id)).json.items as Item[];
    expect(items.map((x) => x.kind)).toEqual(['audit', 'note', 'activity', 'audit']);
    expect(items.map((x) => x.entry?.action).filter(Boolean)).toEqual(['lead.update', 'lead.create']);
    const times = items.map((x) => Date.parse(x.at));
    expect(times).toEqual([...times].sort((p, q) => q - p));
  });

  it('分页不漏不重（含同一时刻的条目）/ paging loses or repeats nothing, ties included', async () => {
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '多条记录客户' } })).json;
    const at = new Date(Date.now() - 60_000);
    // 40 条同一毫秒的备注，再加 25 条不同时间的跟进 / 40 notes at one instant plus 25 activities at different times
    await prisma.note.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ organizationId: a.org.id, accountId: acct.id, authorId: a.user.id, content: `备注${i}`, createdAt: at })) });
    await prisma.activity.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ organizationId: a.org.id, accountId: acct.id, ownerId: a.user.id, type: 'TASK', subject: `任务${i}`, createdAt: new Date(at.getTime() - (i + 1) * 1000) })) });
    const first = (await page('account', acct.id)).json;
    expect(first.items).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    const items = await all('account', acct.id);
    // 40 备注 + 25 跟进 + 1 条新建客户的审计 / 40 notes + 25 activities + the account.create audit
    expect(items).toHaveLength(66);
    expect(new Set(items.map((x) => `${x.kind}-${x.id}`)).size).toBe(66);
  });

  it('可见范围、区域只读、IP、参数校验 / visibility, territory, IPs, validation', async () => {
    const owner = await addUser(a.org.id, 'SALES', '负责人');
    const lead = (await call(leads.POST, { token: owner.token, body: { name: '负责人的线索' } })).json;
    expect((await page('lead', lead.id, sales.token)).status).toBe(404);
    // 区域成员可看区域内他人的商机时间线；跟进仍按查看者范围 / territory members read the deal timeline; activities follow the viewer
    const ter = (await call(territories.POST, { token: a.token, body: { name: '华东', memberIds: [sales.user.id] } })).json;
    const acct = (await call(accounts.POST, { token: a.token, body: { name: '区域客户', ownerId: owner.user.id, territoryId: ter.id } })).json;
    const deal = (await call(deals.POST, { token: owner.token, body: { name: '区域商机', accountId: acct.id } })).json;
    await call(activities.POST, { token: owner.token, body: { type: 'CALL', subject: '负责人的电话', dealId: deal.id } });
    await call(notes.POST, { token: owner.token, body: { dealId: deal.id, content: '负责人的备注' } });
    const seen = (await page('deal', deal.id, sales.token)).json.items as Item[];
    expect(seen.map((x) => x.kind).sort()).toEqual(['audit', 'note']);
    expect(seen.find((x) => x.kind === 'audit')!.entry!.ip).toBeNull();
    // 有审计权限才返回 IP（测试请求没有 IP 时为空，字段仍存在）/ IPs only for audit readers
    const adminSeen = (await page('deal', deal.id)).json.items as Item[];
    expect(adminSeen.map((x) => x.kind).sort()).toEqual(['activity', 'audit', 'note']);
    expect('ip' in adminSeen.find((x) => x.kind === 'audit')!.entry!).toBe(true);
    // 其他组织 404；参数校验 / other organizations 404; validation
    const b = await createTenant('B');
    expect((await page('deal', deal.id, b.token)).status).toBe(404);
    expect((await page('contact', deal.id)).status).toBe(400);
    expect((await page('deal', 'x')).status).toBe(400);
    expect((await page('deal', deal.id, a.token, { before: 'yesterday' })).status).toBe(400);
  });

  it('单字段修改：只改提交的字段、写审计并出现在时间线 / single-field edits', async () => {
    const acct = (await call(accounts.POST, { token: sales.token, body: { name: '客户' } })).json;
    const deal = (await call(deals.POST, { token: sales.token, body: { name: '商机', accountId: acct.id, amount: '100', description: '原描述' } })).json;
    const r = await call(dealItem.PATCH, { token: sales.token, params: { id: deal.id }, body: { expectedCloseDate: '2027-01-15' }, method: 'PATCH' });
    expect(r.json).toMatchObject({ expectedCloseDate: '2027-01-15T00:00:00.000Z', description: '原描述', amount: '100' });
    const cleared = await call(dealItem.PATCH, { token: sales.token, params: { id: deal.id }, body: { description: null }, method: 'PATCH' });
    expect(cleared.json.description).toBeNull();
    const items = (await page('deal', deal.id, sales.token)).json.items as Item[];
    expect(items.filter((x) => x.entry?.action === 'deal.update')).toHaveLength(2);
    // 不能编辑他人的记录 / others' records cannot be edited
    const other = await addUser(a.org.id, 'SALES', '他人');
    expect((await call(dealItem.PATCH, { token: other.token, params: { id: deal.id }, body: { name: '改' }, method: 'PATCH' })).status).toBe(404);
  });
});
