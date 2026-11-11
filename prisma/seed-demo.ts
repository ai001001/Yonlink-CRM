/**
 * 演示环境种子数据（幂等）：独立的“演示企业（演示数据）”组织、各角色演示账号与标注【演示】的业务数据。
 * 演示账号密码随机生成且不输出，只能通过 DEMO_LOGIN_ENABLED=1 时的一键登录使用。
 * Demo seed (idempotent): a separate demo organization, one demo account per role and business data
 * labelled 【演示】. Passwords are random and never printed; accounts are usable only via one-click demo login.
 *
 * 用法 / Usage: npm run db:seed-demo
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { UserRole } from '../src/generated/prisma/enums';
import { hashPassword } from '../src/server/auth';
import { prisma } from '../src/server/db';

export const DEMO_ORG_NAME = '演示企业（演示数据）';

const USERS: { key: string; name: string; email: string; role: UserRole }[] = [
  { key: 'admin', name: '林管理', email: 'admin@demo.yonlink.test', role: 'ADMIN' },
  { key: 'manager', name: '郑经理', email: 'manager@demo.yonlink.test', role: 'MANAGER' },
  { key: 'sales1', name: '王芳', email: 'sales1@demo.yonlink.test', role: 'SALES' },
  { key: 'sales2', name: '陈静', email: 'sales2@demo.yonlink.test', role: 'SALES' },
  { key: 'viewer', name: '周会计', email: 'viewer@demo.yonlink.test', role: 'READONLY' },
];

/**
 * 写入演示数据；组织已存在时只补齐账号，不重复生成业务数据。
 * Seed demo data; when the organization exists only missing accounts are added.
 */
export async function seedDemo(): Promise<void> {
  let org = await prisma.organization.findFirst({ where: { name: DEMO_ORG_NAME } });
  const fresh = !org;
  org ??= await prisma.organization.create({ data: { name: DEMO_ORG_NAME } });

  const ids: Record<string, string> = {};
  for (const u of USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    const user =
      existing ??
      (await prisma.user.create({
        data: {
          organizationId: org.id,
          name: u.name,
          email: u.email,
          role: u.role,
          isDemo: true,
          // 随机且不输出的密码：演示账号不能用密码登录 / random, never printed: no password login
          passwordHash: await hashPassword(randomBytes(24).toString('base64url')),
        },
      }));
    ids[u.key] = user.id;
  }
  if (!fresh) {
    console.log(`演示组织已存在，已补齐账号 / demo organization exists, accounts ensured: ${DEMO_ORG_NAME}`);
    return;
  }

  const o = org.id;
  // 每位销售各自负责的数据，用于演示“销售代表只看自己负责的记录” / per-rep data to show own-records visibility
  const reps = [
    { owner: ids.sales1!, account: '【演示】杭州远望制造', contact: '【演示】陈经理', lead: '【演示】张先生', company: '上海星河科技', deal: '【演示】远望年度采购', amount: '1280000.00', stage: 'PROPOSAL' as const },
    { owner: ids.sales2!, account: '【演示】成都锦城物流', contact: '【演示】刘总', lead: '【演示】李女士', company: '南京钟山软件', deal: '【演示】锦城仓储系统', amount: '560000.00', stage: 'NEGOTIATION' as const },
  ];
  for (const r of reps) {
    const account = await prisma.account.create({ data: { organizationId: o, ownerId: r.owner, name: r.account, industry: 'MANUFACTURING' } });
    await prisma.contact.create({ data: { organizationId: o, accountId: account.id, name: r.contact, isPrimary: true } });
    const deal = await prisma.deal.create({
      data: { organizationId: o, ownerId: r.owner, accountId: account.id, name: r.deal, amount: r.amount, stage: r.stage, expectedCloseDate: new Date('2027-03-31T00:00:00Z') },
    });
    const lead = await prisma.lead.create({ data: { organizationId: o, ownerId: r.owner, name: r.lead, company: r.company, source: 'EXHIBITION', status: 'CONTACTED' } });
    await prisma.activity.create({ data: { organizationId: o, ownerId: r.owner, type: 'CALL', subject: '【演示】首次电话沟通', leadId: lead.id, completed: true, completedAt: new Date() } });
    await prisma.activity.create({ data: { organizationId: o, ownerId: r.owner, type: 'TASK', subject: '【演示】发送报价单', dealId: deal.id, accountId: account.id, dueAt: new Date(Date.now() + 3 * 86400_000) } });
  }
  await prisma.lead.create({ data: { organizationId: o, ownerId: ids.manager!, name: '【演示】赵先生', company: '广州珠江贸易', source: 'WEBSITE' } });
  console.log(`已创建演示组织、${USERS.length} 个演示账号与演示数据 / demo organization, accounts and data created`);
}

// 直接运行时执行 / run when executed directly
if (process.argv[1]?.endsWith('seed-demo.ts')) {
  await seedDemo();
  await prisma.$disconnect();
}
