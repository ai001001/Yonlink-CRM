/**
 * 线索转化 第一轮：功能测试（新建/已有客户、联系人、可选商机、跟进迁移、状态与结果链接）。
 * Lead conversion round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as activities from '@/app/api/activities/route';
import * as leads from '@/app/api/leads/route';
import * as leadItem from '@/app/api/leads/[id]/route';
import * as convert from '@/app/api/leads/[id]/convert/route';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
});

const full = { name: '张三', company: '上海星河科技', title: '采购经理', phone: '021-5555', mobile: '13800000000', email: 'zs@example.com', status: 'QUALIFIED' };
const mkLead = async (body: object = full) => (await call(leads.POST, { token: a.token, body })).json;
const doConvert = (id: string, body: object) => call(convert.POST, { token: a.token, params: { id }, body });

describe('lead conversion R1 functional', () => {
  it('转化为新客户 + 联系人（不建商机），字段正确映射 / new account + contact, fields mapped', async () => {
    const lead = await mkLead();
    const res = await doConvert(lead.id, { account: { mode: 'new' } });
    expect(res.status).toBe(200);
    expect(res.json.account.name).toBe('上海星河科技');
    expect(res.json.deal).toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: res.json.account.id } });
    expect(account).toMatchObject({ organizationId: a.org.id, ownerId: a.user.id, phone: '021-5555' });
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: res.json.contact.id } });
    expect(contact).toMatchObject({ accountId: account.id, name: '张三', title: '采购经理', phone: '13800000000', email: 'zs@example.com', isPrimary: true });

    expect(res.json.lead).toMatchObject({
      status: 'CONVERTED',
      convertedAccount: { id: account.id, name: '上海星河科技' },
      convertedContact: { id: contact.id, name: '张三' },
      convertedDeal: null,
    });
    expect(res.json.lead.convertedAt).not.toBeNull();
  });

  it('自定义新客户名称；无公司名时默认用姓名 / custom account name; falls back to lead name', async () => {
    const l1 = await mkLead();
    expect((await doConvert(l1.id, { account: { mode: 'new', name: '星河集团' } })).json.account.name).toBe('星河集团');
    const l2 = await mkLead({ name: '个人客户李四' });
    expect((await doConvert(l2.id, { account: { mode: 'new' } })).json.account.name).toBe('个人客户李四');
  });

  it('同时创建商机：金额、阶段、日期、关联客户 / creates a deal with amount, stage, date', async () => {
    const lead = await mkLead();
    const res = await doConvert(lead.id, {
      account: { mode: 'new' },
      deal: { name: '星河年度采购', amount: '88000.50', stage: 'PROPOSAL', expectedCloseDate: '2027-04-30' },
    });
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: res.json.deal.id } });
    expect(deal).toMatchObject({ name: '星河年度采购', stage: 'PROPOSAL', currency: 'CNY', accountId: res.json.account.id, ownerId: a.user.id });
    expect(deal.amount.toString()).toBe('88000.5');
    expect(deal.expectedCloseDate?.toISOString().slice(0, 10)).toBe('2027-04-30');
    expect(res.json.lead.convertedDeal).toEqual({ id: deal.id, name: '星河年度采购' });
  });

  it('关联已有客户：已有主要联系人时新联系人不设为主要 / existing account keeps its primary contact', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '已有客户' } })).json;
    await call(accountContacts.POST, { token: a.token, params: { id: acc.id }, body: { name: '原主要联系人', isPrimary: true } });
    const lead = await mkLead();
    const res = await doConvert(lead.id, { account: { mode: 'existing', accountId: acc.id } });
    expect(res.json.account).toEqual({ id: acc.id, name: '已有客户' });
    expect(await prisma.account.count()).toBe(1);
    const contacts = await prisma.contact.findMany({ where: { accountId: acc.id }, orderBy: { createdAt: 'asc' } });
    expect(contacts.map((c) => [c.name, c.isPrimary])).toEqual([['原主要联系人', true], ['张三', false]]);
  });

  it('已有客户没有主要联系人时，新联系人成为主要联系人 / becomes primary when the account has none', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '无联系人客户' } })).json;
    const lead = await mkLead();
    await doConvert(lead.id, { account: { mode: 'existing', accountId: acc.id } });
    expect((await prisma.contact.findFirstOrThrow({ where: { accountId: acc.id } })).isPrimary).toBe(true);
  });

  it('线索的跟进记录关联到新客户与商机，且线索关联保留 / activities move to account and deal, lead link kept', async () => {
    const lead = await mkLead();
    await call(activities.POST, { token: a.token, body: { type: 'CALL', subject: '首次电话', leadId: lead.id, completed: true } });
    await call(activities.POST, { token: a.token, body: { type: 'TASK', subject: '发资料', leadId: lead.id } });
    const res = await doConvert(lead.id, { account: { mode: 'new' }, deal: { name: '商机' } });
    const rows = await prisma.activity.findMany();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.leadId, r.accountId, r.dealId]).toEqual([lead.id, res.json.account.id, res.json.deal.id]);
    // 客户详情可查到这些跟进 / visible from the account
    expect((await call(activities.GET, { token: a.token, query: { accountId: res.json.account.id } })).json.total).toBe(2);
  });

  it('线索详情返回转化结果；仍可编辑非状态字段 / detail shows result; non-status fields remain editable', async () => {
    const lead = await mkLead();
    const res = await doConvert(lead.id, { account: { mode: 'new' } });
    const detail = (await call(leadItem.GET, { token: a.token, params: { id: lead.id } })).json;
    expect(detail.convertedAccount.id).toBe(res.json.account.id);
    const upd = await call(leadItem.PATCH, { token: a.token, method: 'PATCH', params: { id: lead.id }, body: { description: '已签约' } });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject({ description: '已签约', status: 'CONVERTED' });
  });

  it('列表可按“已转化”筛选 / list filter by CONVERTED', async () => {
    const l1 = await mkLead();
    await mkLead({ name: '未转化' });
    await doConvert(l1.id, { account: { mode: 'new' } });
    const res = await call(leads.GET, { token: a.token, query: { status: 'CONVERTED' } });
    expect(res.json.items.map((l: { name: string }) => l.name)).toEqual(['张三']);
  });
});
