/**
 * 区域可见范围 第一轮：功能测试（销售代表可只读所在区域（含下级）的客户、联系人与商机及其明细、备注、附件、得分；
 * 编辑、新增子记录、删除仍只限负责人；不在区域、移出区域立即不可见；经理、负责人不受影响；跟进与报价单仍按负责人）。
 * Territory visibility round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as accountContacts from '@/app/api/accounts/[id]/contacts/route';
import * as accountItem from '@/app/api/accounts/[id]/route';
import * as accountScore from '@/app/api/accounts/[id]/score/route';
import * as accounts from '@/app/api/accounts/route';
import * as attachmentsList from '@/app/api/attachments/route';
import * as contactItem from '@/app/api/contacts/[id]/route';
import * as contacts from '@/app/api/contacts/route';
import * as competitors from '@/app/api/deals/[id]/competitors/route';
import * as roles from '@/app/api/deals/[id]/contact-roles/route';
import * as items from '@/app/api/deals/[id]/items/route';
import * as dealItem from '@/app/api/deals/[id]/route';
import * as dealScore from '@/app/api/deals/[id]/score/route';
import * as stageHistory from '@/app/api/deals/[id]/stage-history/route';
import * as board from '@/app/api/deals/board/route';
import * as deals from '@/app/api/deals/route';
import * as notes from '@/app/api/notes/route';
import * as territoryItem from '@/app/api/territories/[id]/route';
import * as territories from '@/app/api/territories/route';
import { prisma } from '@/server/db';
import { fetchFile, upload } from '../attachments/files';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let rep: Awaited<ReturnType<typeof addUser>>;
let owner: Awaited<ReturnType<typeof addUser>>;
let outsider: Awaited<ReturnType<typeof addUser>>;
let east: string;
let shanghai: string;
let north: string;
let acct: string;
let otherAcct: string;
let contact: string;
let deal: string;

const names = async (handler: typeof accounts.GET, token: string, query: Record<string, string> = {}) =>
  ((await call(handler, { token, query })).json.items as { name: string }[]).map((x) => x.name).sort();

beforeEach(async () => {
  await resetDb();
  a = await createTenant('A');
  rep = await addUser(a.org.id, 'SALES', '区域代表');
  owner = await addUser(a.org.id, 'SALES', '负责人');
  outsider = await addUser(a.org.id, 'SALES', '区外');
  east = (await call(territories.POST, { token: a.token, body: { name: '华东', memberIds: [rep.user.id] } })).json.id;
  shanghai = (await call(territories.POST, { token: a.token, body: { name: '上海', parentId: east } })).json.id;
  north = (await call(territories.POST, { token: a.token, body: { name: '华北', managerId: outsider.user.id } })).json.id;
  acct = (await call(accounts.POST, { token: a.token, body: { name: '上海客户', ownerId: owner.user.id, territoryId: shanghai } })).json.id;
  otherAcct = (await call(accounts.POST, { token: a.token, body: { name: '北京客户', ownerId: owner.user.id, territoryId: north } })).json.id;
  await call(accounts.POST, { token: a.token, body: { name: '无区域客户', ownerId: owner.user.id } });
  contact = (await call(accountContacts.POST, { token: a.token, params: { id: acct }, body: { name: '上海联系人' } })).json.id;
  await call(accountContacts.POST, { token: a.token, params: { id: otherAcct }, body: { name: '北京联系人' } });
  deal = (await call(deals.POST, { token: a.token, body: { name: '上海商机', accountId: acct, ownerId: owner.user.id, amount: '1000' } })).json.id;
  await call(deals.POST, { token: a.token, body: { name: '北京商机', accountId: otherAcct, ownerId: owner.user.id } });
});

describe('territory visibility R1', () => {
  it('列表：区域成员看到下级区域的客户、联系人、商机与看板 / lists include descendant territories', async () => {
    expect(await names(accounts.GET, rep.token)).toEqual(['上海客户']);
    // 商机数按可读范围计数（负责人的商机计入）/ deal counts follow the readable scope
    expect((await call(accounts.GET, { token: rep.token })).json.items[0]._count).toEqual({ contacts: 1, deals: 1 });
    expect((await call(accounts.GET, { token: outsider.token })).json.items[0]._count).toEqual({ contacts: 1, deals: 1 });
    expect(await names(contacts.GET, rep.token)).toEqual(['上海联系人']);
    expect(await names(deals.GET, rep.token)).toEqual(['上海商机']);
    const cols = (await call(board.GET, { token: rep.token })).json.columns as { items: { name: string }[] }[];
    expect(cols.flatMap((c) => c.items.map((x) => x.name))).toEqual(['上海商机']);
    // 区域经理同样适用 / territory managers too
    expect(await names(accounts.GET, outsider.token)).toEqual(['北京客户']);
    // 筛选仍与可见范围取交集 / filters still intersect visibility
    expect(await names(accounts.GET, rep.token, { territoryId: north })).toEqual([]);
    expect(await names(accounts.GET, rep.token, { territoryId: 'MINE' })).toEqual(['上海客户']);
    expect(await names(deals.GET, rep.token, { ownerId: owner.user.id })).toEqual(['上海商机']);
    // 负责人与管理员不受影响 / owners and admins unchanged
    expect(await names(accounts.GET, owner.token)).toEqual(['上海客户', '北京客户', '无区域客户'].sort());
    expect(await names(accounts.GET, a.token)).toHaveLength(3);
  });

  it('详情与明细可读：客户、联系人、商机、产品明细、联系人角色、竞争对手、阶段历史、得分、备注、附件 / details readable', async () => {
    expect((await call(accountItem.GET, { token: rep.token, params: { id: acct } })).json).toMatchObject({ name: '上海客户', contacts: [{ name: '上海联系人' }] });
    expect((await call(accountContacts.GET, { token: rep.token, params: { id: acct } })).status).toBe(200);
    expect((await call(contactItem.GET, { token: rep.token, params: { id: contact } })).json.name).toBe('上海联系人');
    expect((await call(dealItem.GET, { token: rep.token, params: { id: deal } })).json.name).toBe('上海商机');
    for (const h of [items.GET, roles.GET, competitors.GET, stageHistory.GET, dealScore.GET]) {
      expect((await call(h, { token: rep.token, params: { id: deal } })).status).toBe(200);
    }
    expect((await call(accountScore.GET, { token: rep.token, params: { id: acct } })).status).toBe(200);
    await call(notes.POST, { token: owner.token, body: { accountId: acct, content: '负责人备注' } });
    expect((await call(notes.GET, { token: rep.token, query: { accountId: acct } })).json.items).toMatchObject([{ content: '负责人备注' }]);
    const file = await upload(owner.token, { dealId: deal }, '方案.txt', '内容');
    expect(file.status).toBe(201);
    expect((await call(attachmentsList.GET, { token: rep.token, query: { dealId: deal } })).json.items).toHaveLength(1);
    expect((await fetchFile(rep.token, file.json.id)).status).toBe(200);
    // 其他区域、无区域仍 404 / other territories stay 404
    expect((await call(accountItem.GET, { token: rep.token, params: { id: otherAcct } })).status).toBe(404);
    expect((await fetchFile(outsider.token, file.json.id)).status).toBe(404);
  });

  it('只读：编辑、删除、新增子记录、上传仍只限负责人 / read only: writes stay owner-only', async () => {
    // 拒绝：与读取共用查找的路径为 403，写入专用查找（只按负责人）的路径为 404 / refused: 403 or 404 by lookup
    const refused = (status: number) => expect([403, 404]).toContain(status);
    expect((await call(accountItem.PATCH, { token: rep.token, params: { id: acct }, body: { name: '改名' }, method: 'PATCH' })).status).toBe(403);
    expect((await call(accountItem.DELETE, { token: rep.token, params: { id: acct }, method: 'DELETE' })).status).toBe(403);
    expect((await call(accountContacts.POST, { token: rep.token, params: { id: acct }, body: { name: '新联系人' } })).status).toBe(403);
    refused((await call(contactItem.PATCH, { token: rep.token, params: { id: contact }, body: { name: '改名' }, method: 'PATCH' })).status);
    refused((await call(contactItem.DELETE, { token: rep.token, params: { id: contact }, method: 'DELETE' })).status);
    refused((await call(dealItem.PATCH, { token: rep.token, params: { id: deal }, body: { name: '改名' }, method: 'PATCH' })).status);
    expect((await call(competitors.POST, { token: rep.token, params: { id: deal }, body: { name: '对手' } })).status).toBe(403);
    expect((await call(roles.POST, { token: rep.token, params: { id: deal }, body: { contactId: contact, role: 'DECISION_MAKER' } })).status).toBe(403);
    expect((await call(notes.POST, { token: rep.token, body: { dealId: deal, content: '代表备注' } })).status).toBe(403);
    expect((await upload(rep.token, { accountId: acct }, 'x.txt', 'x')).status).toBe(403);
    // 不能把商机挂到只读客户上 / cannot attach a new deal to a read-only account
    expect((await call(deals.POST, { token: rep.token, body: { name: '代表商机', accountId: acct } })).status).toBe(400);
    const after = await prisma.account.findUniqueOrThrow({ where: { id: acct } });
    expect(after.name).toBe('上海客户');
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact } })).name).toBe('上海联系人');
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal } })).name).toBe('上海商机');
    expect(await prisma.dealCompetitor.count({ where: { dealId: deal } })).toBe(0);
    expect(await prisma.note.count({ where: { dealId: deal } })).toBe(0);
  });

  it('移出区域、区域改挂、客户换区域立即生效 / changes apply immediately', async () => {
    expect(await names(accounts.GET, rep.token)).toEqual(['上海客户']);
    // 把上海挂到华北下：代表不再可见，华北经理可见 / move 上海 under 华北
    await call(territoryItem.PATCH, { token: a.token, params: { id: shanghai }, body: { parentId: north }, method: 'PATCH' });
    expect(await names(accounts.GET, rep.token)).toEqual([]);
    expect(await names(accounts.GET, outsider.token)).toEqual(['上海客户', '北京客户'].sort());
    await call(territoryItem.PATCH, { token: a.token, params: { id: shanghai }, body: { parentId: east }, method: 'PATCH' });
    expect(await names(deals.GET, rep.token)).toEqual(['上海商机']);
    // 移出成员 / remove the member
    await call(territoryItem.PATCH, { token: a.token, params: { id: east }, body: { memberIds: [] }, method: 'PATCH' });
    expect(await names(accounts.GET, rep.token)).toEqual([]);
    expect((await call(dealItem.GET, { token: rep.token, params: { id: deal } })).status).toBe(404);
    expect((await call(contactItem.GET, { token: rep.token, params: { id: contact } })).status).toBe(404);
  });

  it('跟进与报价单仍按负责人；无区域用户不变 / activities and quotes stay owner-only', async () => {
    expect(await names(accounts.GET, (await addUser(a.org.id, 'SALES', '新人')).token)).toEqual([]);
    const own = await call(accounts.POST, { token: rep.token, body: { name: '代表自己的客户' } });
    expect(own.status).toBe(201);
    expect(await names(accounts.GET, rep.token)).toEqual(['上海客户', '代表自己的客户'].sort());
    const quotes = await import('@/app/api/quotes/route');
    expect((await call(quotes.GET, { token: rep.token, query: { dealId: deal } })).json.items).toEqual([]);
    const activities = await import('@/app/api/activities/route');
    await call(activities.POST, { token: owner.token, body: { type: 'CALL', subject: '负责人电话', dealId: deal } });
    expect((await call(activities.GET, { token: rep.token, query: { dealId: deal } })).json.items).toEqual([]);
  });
});
