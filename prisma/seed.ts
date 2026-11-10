/**
 * 初始化/演示数据脚本（幂等）。
 * Initial / demo data seed (idempotent).
 *
 * - 必需环境变量 / required env: DATABASE_URL, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
 * - 可选 / optional: SEED_ORG_NAME
 * 本脚本只创建组织和管理员账号，不生成任何伪造业务数据。
 * Only creates the organization and admin account; no fabricated business data.
 */
import 'dotenv/config';
import { hashPassword } from '../src/server/auth';
import { prisma } from '../src/server/db';

const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;
const orgName = process.env.SEED_ORG_NAME ?? '永联CRM 演示组织（演示数据）';

if (!email || !password || password.length < 10) {
  console.error('需要 SEED_ADMIN_EMAIL 与至少 10 位的 SEED_ADMIN_PASSWORD / SEED_ADMIN_EMAIL and a 10+ char SEED_ADMIN_PASSWORD are required');
  process.exit(1);
}

const existing = await prisma.user.findUnique({ where: { email } });
if (existing) {
  await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: await hashPassword(password), isActive: true } });
  console.log(`已更新管理员密码 / admin password updated: ${email}`);
} else {
  const org = await prisma.organization.create({ data: { name: orgName } });
  await prisma.user.create({
    data: { organizationId: org.id, email, name: '系统管理员', passwordHash: await hashPassword(password) },
  });
  console.log(`已创建组织与管理员 / created organization and admin: ${orgName} / ${email}`);
}
await prisma.$disconnect();
