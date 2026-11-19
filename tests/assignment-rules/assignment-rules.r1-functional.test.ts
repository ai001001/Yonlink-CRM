/**
 * 线索分配规则 第一轮：功能测试（读取空规则；保存与顺序、条件与负责人校验、引用校验、权限；条件匹配（等于/包含/开头/结尾、
 * 不区分大小写、全部满足、无条件兜底、停用规则跳过）；轮流分配与跳过停用负责人、全部停用时继续下一条；
 * 网页表单按规则分配（与固定负责人互斥、通知、审计注明规则、无命中不分配）；导入按规则分配（文件中负责人优先、
 * 无命中归导入人、需 owner.assign、仅线索）；批量按规则重新分配（无命中失败、已转化失败、需 owner.assign）；审计）。
 * Assignment rules round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as rulesRoute from '@/app/api/assignment-rules/route';
import * as accountImport from '@/app/api/accounts/import/route';
import * as campaigns from '@/app/api/campaigns/route';
import * as leadBulk from '@/app/api/leads/bulk/route';
import * as leadConvert from '@/app/api/leads/[id]/convert/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leads from '@/app/api/leads/route';
import * as publicForm from '@/app/api/public/web-forms/[key]/route';
import * as formItem from '@/app/api/web-forms/[id]/route';
import * as forms from '@/app/api/web-forms/route';
import { prisma } from '@/server/db';
import { conditionHolds, ruleMatches } from '@/server/modules/assignment-rules';
import { resetWebFormLimiter } from '@/server/modules/web-forms';
import { addUser, call, createTenant, resetDb } from '../helpers';

let a: Awaited<ReturnType<typeof createTenant>>;
let s1: Awaited<ReturnType<typeof addUser>>;
let s2: Awaited<ReturnType<typeof addUser>>;
let s3: Awaited<ReturnType<typeof addUser>>;
let ipSeq = 0;

const save = (rules: object[], token = a.token) => call(rulesRoute.PUT, { token, body: { rules }, method: 'PUT' });
const read = (token = a.token) => call(rulesRoute.GET, { token });
const rule = (name: string, userIds: string[], conditions: object[] = [], extra: object = {}) => ({ name, userIds, conditions, ...extra });
const submit = (key: string, body: object) => call(publicForm.POST, { params: { key }, body, headers: { 'x-forwarded-for': `10.1.0.${++ipSeq}` } });
const importLeads = (csv: string, body: object = {}, token = a.token) => call(leadImport.POST, { token, body: { csv, dryRun: false, duplicates: 'create', ...body } });

beforeEach(async () => {
  await resetDb();
  resetWebFormLimiter();
  a = await createTenant('A');
  s1 = await addUser(a.org.id, 'SALES', '销售一');
  s2 = await addUser(a.org.id, 'SALES', '销售二');
  s3 = await addUser(a.org.id, 'SALES', '销售三');
});

describe('assignment rules R1 matching', () => {
  it('条件：来源/活动/表单等于；文本等于、包含、开头、结尾，不区分大小写并去空格；空值不匹配 / conditions', () => {
    const lead = { source: 'WEBSITE', campaignId: 'c1', webFormId: 'f1', company: '  Acme 汽配 Co. ', title: '采购经理', email: 'Buyer@Acme.DE', description: null };
    expect(conditionHolds({ field: 'source', op: 'EQUALS', value: 'WEBSITE' }, lead)).toBe(true);
    expect(conditionHolds({ field: 'source', op: 'EQUALS', value: 'REFERRAL' }, lead)).toBe(false);
    expect(conditionHolds({ field: 'campaign', op: 'EQUALS', value: 'c1' } as never, lead)).toBe(true);
    expect(conditionHolds({ field: 'webForm', op: 'EQUALS', value: 'f2' } as never, lead)).toBe(false);
    expect(conditionHolds({ field: 'company', op: 'EQUALS', value: 'acme 汽配 co.' }, lead)).toBe(true);
    expect(conditionHolds({ field: 'company', op: 'CONTAINS', value: '汽配' }, lead)).toBe(true);
    expect(conditionHolds({ field: 'title', op: 'STARTS_WITH', value: '采购' }, lead)).toBe(true);
    expect(conditionHolds({ field: 'title', op: 'STARTS_WITH', value: '经理' }, lead)).toBe(false);
    expect(conditionHolds({ field: 'email', op: 'ENDS_WITH', value: '@acme.de' }, lead)).toBe(true);
    expect(conditionHolds({ field: 'description', op: 'CONTAINS', value: 'x' }, lead)).toBe(false);
    // 全部满足；无条件匹配全部 / all must hold; no conditions match everything
    expect(ruleMatches([{ field: 'source', op: 'EQUALS', value: 'WEBSITE' }, { field: 'title', op: 'CONTAINS', value: '采购' }], lead)).toBe(true);
    expect(ruleMatches([{ field: 'source', op: 'EQUALS', value: 'WEBSITE' }, { field: 'title', op: 'CONTAINS', value: '工程' }], lead)).toBe(false);
    expect(ruleMatches([], {})).toBe(true);
  });
});

describe('assignment rules R1 maintenance', () => {
  it('读取、保存与顺序、校验、权限、审计 / read, save, validate, permissions, audit', async () => {
    expect((await read()).json).toEqual({ rules: [], names: { campaign: {}, webForm: {} } });
    const campaign = (await call(campaigns.POST, { token: a.token, body: { name: '春季展会', type: 'EXHIBITION' } })).json;
    const r = await save([
      rule('展会', [s1.user.id, s2.user.id], [{ field: 'source', op: 'EQUALS', value: 'EXHIBITION' }, { field: 'campaign', op: 'EQUALS', value: campaign.id }]),
      rule('兜底', [s3.user.id], [], { isActive: false }),
    ]);
    expect(r.status).toBe(200);
    expect(r.json.rules.map((x: { name: string; isActive: boolean; cursor: number; users: { id: string }[] }) => [x.name, x.isActive, x.cursor, x.users.map((u) => u.id)])).toEqual([
      ['展会', true, 0, [s1.user.id, s2.user.id]],
      ['兜底', false, 0, [s3.user.id]],
    ]);
    expect(r.json.names.campaign).toEqual({ [campaign.id]: '春季展会' });
    // 所有用户可查看 / everyone can read
    expect((await read(s1.token)).json.rules).toHaveLength(2);

    // 校验 / validation
    const b = await createTenant('B');
    const bad: [object, number][] = [
      [rule(' ', [s1.user.id]), 400],
      [rule('无人', []), 400],
      [rule('重复', [s1.user.id, s1.user.id]), 400],
      [rule('他组织', [b.user.id]), 400],
      [rule('字段', [s1.user.id], [{ field: 'phone', op: 'EQUALS', value: '1' }]), 400],
      [rule('来源只能等于', [s1.user.id], [{ field: 'source', op: 'CONTAINS', value: 'WEB' }]), 400],
      [rule('来源值', [s1.user.id], [{ field: 'source', op: 'EQUALS', value: 'TV' }]), 400],
      [rule('空值', [s1.user.id], [{ field: 'company', op: 'CONTAINS', value: '  ' }]), 400],
      [rule('多余', [s1.user.id], [], { cursor: 5 }), 400],
      [rule('六条', [s1.user.id], Array.from({ length: 6 }, () => ({ field: 'company', op: 'CONTAINS', value: 'a' }))), 400],
      [rule('活动不存在', [s1.user.id], [{ field: 'campaign', op: 'EQUALS', value: '00000000-0000-4000-8000-000000000000' }]), 400],
    ];
    for (const [body, status] of bad) expect((await save([body])).status, JSON.stringify(body)).toBe(status);
    expect((await save([rule('他组织', [b.user.id])])).json.error.details).toEqual({ 'rules.0.userIds': ['user_not_found'] });
    // 停用用户不能加入规则 / inactive users cannot be added
    await prisma.user.update({ where: { id: s3.user.id }, data: { isActive: false } });
    expect((await save([rule('停用', [s3.user.id])])).json.error.details).toEqual({ 'rules.0.userIds': ['user_not_found'] });
    expect((await save(Array.from({ length: 51 }, (_, i) => rule(`r${i}`, [s1.user.id])))).status).toBe(400);
    // 失败不改变已有规则 / failures keep the saved rules
    expect((await read()).json.rules).toHaveLength(2);

    // 权限：销售、只读 403；经理可以 / permissions
    expect((await save([], s1.token)).status).toBe(403);
    const viewer = await addUser(a.org.id, 'READONLY', '只读');
    expect((await save([], viewer.token)).status).toBe(403);
    const mgr = await addUser(a.org.id, 'MANAGER', '经理');
    expect((await save([rule('经理规则', [s1.user.id])], mgr.token)).status).toBe(200);

    // 审计：规则文本前后对比 / audit: rule texts before → after
    const logs = await prisma.auditLog.findMany({ where: { action: 'assignment.update' }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[0]!.changes).toEqual({
      entity: 'LEAD',
      count: 2,
      rules: [[], [`展会: source EQUALS EXHIBITION & campaign EQUALS ${campaign.id} → 销售一${s1.user.name.slice(3)}/销售二${s2.user.name.slice(3)}`, `兜底 (off): * → ${s3.user.name}`]],
    });
    expect(logs[1]!.actorId).toBe(mgr.user.id);
    // 另一组织看不到 / another organization sees nothing
    expect((await read(b.token)).json.rules).toEqual([]);
  });
});

describe('assignment rules R1 web forms', () => {
  it('按规则轮流分配、跳过停用负责人、无命中不分配、通知与审计、与固定负责人互斥 / web forms', async () => {
    await save([
      rule('官网', [s1.user.id, s2.user.id, s3.user.id], [{ field: 'source', op: 'EQUALS', value: 'WEBSITE' }, { field: 'company', op: 'CONTAINS', value: '汽配' }]),
      rule('停用规则', [s3.user.id], [], { isActive: false }),
    ]);
    // 互斥 / exclusive
    expect((await call(forms.POST, { token: a.token, body: { name: '冲突', title: 'T', ownerId: s1.user.id, assignByRule: true } })).json.error.details).toEqual({ assignByRule: ['owner_set'] });
    const form = (await call(forms.POST, { token: a.token, body: { name: '官网咨询', title: '联系我们', assignByRule: true } })).json;
    expect(form).toMatchObject({ assignByRule: true, ownerId: null });
    expect((await call(formItem.PATCH, { token: a.token, params: { id: form.id }, body: { ownerId: s1.user.id }, method: 'PATCH' })).status).toBe(400);

    const owners: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      expect((await submit(form.publicKey, { name: `访客${i}`, company: '宁波汽配厂' })).status).toBe(200);
      owners.push((await prisma.lead.findFirstOrThrow({ where: { name: `访客${i}` } })).ownerId);
    }
    expect(owners).toEqual([s1.user.id, s2.user.id, s3.user.id, s1.user.id]);
    // 停用负责人被跳过：剩下两人按指针继续轮流 / inactive users are skipped
    await prisma.user.update({ where: { id: s2.user.id }, data: { isActive: false } });
    await submit(form.publicKey, { name: '访客4', company: '汽配' });
    await submit(form.publicKey, { name: '访客5', company: '汽配' });
    const next = await prisma.lead.findMany({ where: { name: { in: ['访客4', '访客5'] } }, orderBy: { name: 'asc' }, select: { ownerId: true } });
    // 指针 5、6 → 可用 [s1, s3] 的第 0、1 位 / cursor 5, 6 → positions 0, 1 of [s1, s3]
    expect(next.map((l) => l.ownerId)).toEqual([s1.user.id, s3.user.id]);
    // 不满足条件、停用规则不生效 → 不分配 / no match (inactive rules ignored) → unassigned
    await submit(form.publicKey, { name: '访客6', company: '电子厂' });
    expect((await prisma.lead.findFirstOrThrow({ where: { name: '访客6' } })).ownerId).toBeNull();

    // 通知与审计 / notification and audit
    const lead0 = await prisma.lead.findFirstOrThrow({ where: { name: '访客0' } });
    expect(await prisma.notification.count({ where: { leadId: lead0.id, userId: s1.user.id, type: 'WEB_FORM_LEAD' } })).toBe(1);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.create', entityId: lead0.id } });
    expect(log.changes).toMatchObject({ webForm: '官网咨询', assignmentRule: '官网' });
    const log6 = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.create', entityId: (await prisma.lead.findFirstOrThrow({ where: { name: '访客6' } })).id } });
    expect(log6.changes).not.toHaveProperty('assignmentRule');
    expect((await read()).json.rules[0].cursor).toBe(6);

    // 关闭按规则后恢复固定负责人 / turning rules off restores the fixed owner
    expect((await call(formItem.PATCH, { token: a.token, params: { id: form.id }, body: { assignByRule: false, ownerId: s3.user.id }, method: 'PATCH' })).status).toBe(200);
    await submit(form.publicKey, { name: '访客7', company: '汽配' });
    expect((await prisma.lead.findFirstOrThrow({ where: { name: '访客7' } })).ownerId).toBe(s3.user.id);
    const upd = await prisma.auditLog.findFirstOrThrow({ where: { action: 'webform.update', entityId: form.id } });
    expect(upd.changes).toEqual({ fields: { ownerId: [null, s3.user.id], assignByRule: [true, false] } });
  });
});

describe('assignment rules R1 import and bulk', () => {
  it('导入：文件中负责人优先、按规则轮流、无命中归导入人、权限与对象限制 / import', async () => {
    await save([rule('展会', [s1.user.id, s2.user.id], [{ field: 'source', op: 'EQUALS', value: 'EXHIBITION' }])]);
    const csv = ['姓名,线索来源,负责人邮箱', '甲,展会,', '乙,展会,', `丙,展会,${s3.user.email}`, '丁,展会,', '戊,官网,'].join('\r\n');
    const dry = await call(leadImport.POST, { token: a.token, body: { csv, dryRun: true, owner: 'rules' } });
    expect(dry.json).toMatchObject({ valid: 5, created: 0, assignedByRule: 0 });
    expect((await read()).json.rules[0].cursor).toBe(0); // 预检不取号 / dry runs take no turns
    const r = await importLeads(csv, { owner: 'rules' });
    expect(r.json).toMatchObject({ created: 5, assignedByRule: 3 });
    const byName = Object.fromEntries((await prisma.lead.findMany({ select: { name: true, ownerId: true } })).map((l) => [l.name, l.ownerId]));
    expect(byName).toEqual({ 甲: s1.user.id, 乙: s2.user.id, 丙: s3.user.id, 丁: s1.user.id, 戊: a.user.id });
    const one = await prisma.lead.findFirstOrThrow({ where: { name: '乙' } });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.create', entityId: one.id } })).changes).toMatchObject({ via: 'lead.import', assignmentRule: '展会' });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.import' } })).changes).toMatchObject({ created: 5, assignedByRule: 3 });
    // 默认归导入人 / default: the importer
    await importLeads('姓名,线索来源\r\n己,展会');
    expect((await prisma.lead.findFirstOrThrow({ where: { name: '己' } })).ownerId).toBe(a.user.id);
    // 销售不能按规则导入；客户导入不支持 / sales cannot; accounts are not supported
    expect((await importLeads('姓名\r\n庚', { owner: 'rules' }, s1.token)).status).toBe(403);
    expect((await importLeads('姓名\r\n庚', {}, s1.token)).status).toBe(200);
    expect((await call(accountImport.POST, { token: a.token, body: { csv: '客户名称\r\n某公司', dryRun: true, owner: 'rules' } })).json.error.details).toEqual({ owner: ['leads_only'] });
    expect((await call(leadImport.POST, { token: a.token, body: { csv: '姓名\r\n辛', owner: 'boss' } })).status).toBe(400);
  });

  it('批量按规则重新分配：成功、无命中、已转化、权限、通知与审计 / bulk reassign', async () => {
    await save([rule('推荐', [s1.user.id, s2.user.id], [{ field: 'source', op: 'EQUALS', value: 'REFERRAL' }])]);
    const mk = async (name: string, source: string | null) => (await call(leads.POST, { token: a.token, body: { name, source } })).json.id as string;
    const [l1, l2, l3, l4] = [await mk('推荐甲', 'REFERRAL'), await mk('推荐乙', 'REFERRAL'), await mk('电话丙', 'COLD_CALL'), await mk('推荐丁', 'REFERRAL')];
    expect((await call(leadConvert.POST, { token: a.token, params: { id: l4 }, body: { account: { mode: 'new' } } })).status).toBe(200);
    const r = await call(leadBulk.POST, { token: a.token, body: { action: 'assign_rule', ids: [l1, l2, l3, l4] } });
    expect(r.json.succeeded).toEqual([l1, l2]);
    expect(r.json.failed.map((f: { id: string; code: string }) => [f.id, f.code])).toEqual([
      [l3, 'CONFLICT'],
      [l4, 'CONFLICT'],
    ]);
    const owners = await prisma.lead.findMany({ where: { id: { in: [l1, l2, l3] } }, select: { id: true, ownerId: true } });
    expect(Object.fromEntries(owners.map((o) => [o.id, o.ownerId]))).toEqual({ [l1]: s1.user.id, [l2]: s2.user.id, [l3]: a.user.id });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'lead.update', entityId: l1 } });
    expect(log.changes).toEqual({ fields: { ownerId: [a.user.id, s1.user.id] }, assignmentRule: '推荐' });
    expect(await prisma.notification.count({ where: { leadId: l1, userId: s1.user.id, type: 'ASSIGNED' } })).toBe(1);
    // 负责人不变时不写审计、不通知 / no audit or notice when the owner stays
    await save([rule('只给一', [s1.user.id], [{ field: 'source', op: 'EQUALS', value: 'REFERRAL' }])]);
    expect((await call(leadBulk.POST, { token: a.token, body: { action: 'assign_rule', ids: [l1] } })).json.succeeded).toEqual([l1]);
    expect(await prisma.auditLog.count({ where: { action: 'lead.update', entityId: l1 } })).toBe(1);
    // 销售无权 / sales are forbidden
    expect((await call(leadBulk.POST, { token: s1.token, body: { action: 'assign_rule', ids: [l1] } })).status).toBe(403);
  });
});
