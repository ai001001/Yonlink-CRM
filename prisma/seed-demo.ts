/**
 * 演示环境种子数据：独立的虚构涡轮增压器企业组织、各角色演示账号与大量标注【演示】的业务数据（数据见 demo-data.ts）。
 * 演示账号密码随机生成且不输出，只能通过 DEMO_LOGIN_ENABLED=1 时的一键登录使用。
 * Demo seed: a separate fictional turbocharger company, one demo account per role and a sizeable set of
 * business data labelled 【演示】 (data in demo-data.ts). Demo passwords are random and never printed.
 *
 * 用法 / Usage:
 *   npm run db:seed-demo            # 组织不存在时创建；已存在时只补齐账号 / create if missing, else ensure accounts
 *   npm run db:seed-demo -- --reset # 清空演示组织业务数据后重新生成（账号与审计日志保留）/ regenerate business data
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/server/auth';
import { prisma } from '../src/server/db';
import { buildDemoData, DEMO_ORG_NAME, DEMO_USERS, LEGACY_DEMO_ORG_NAMES, type OwnerKey } from './demo-data';

export { DEMO_ORG_NAME };

const DAY = 86_400_000;

/**
 * 以今天为基准的日期（UTC 零点 + 偏移天数）。
 * A date relative to today (UTC midnight plus an offset in days).
 */
function dayOffset(days: number): Date {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + days * DAY);
}

/**
 * 写入演示数据。
 * Seed demo data.
 * @param options.reset 清空并重新生成演示组织的业务数据 / wipe and regenerate the demo organization's business data
 */
export async function seedDemo(options: { reset?: boolean } = {}): Promise<void> {
  // 兼容旧名称：改名复用（审计日志只能追加，组织记录不能删除）/ reuse the legacy org (audit logs keep it alive)
  let org = await prisma.organization.findFirst({ where: { name: { in: [DEMO_ORG_NAME, ...LEGACY_DEMO_ORG_NAMES] } } });
  const fresh = !org;
  if (org && org.name !== DEMO_ORG_NAME) org = await prisma.organization.update({ where: { id: org.id }, data: { name: DEMO_ORG_NAME } });
  org ??= await prisma.organization.create({ data: { name: DEMO_ORG_NAME } });
  const o = org.id;

  const ids = {} as Record<(typeof DEMO_USERS)[number]['key'], string>;
  for (const u of DEMO_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    const user =
      existing ??
      (await prisma.user.create({
        data: {
          organizationId: o,
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

  if (!fresh && !options.reset) {
    console.log(`演示组织已存在，已补齐账号（如需重建数据请加 --reset）/ demo org exists, accounts ensured: ${DEMO_ORG_NAME}`);
    return;
  }

  const data = buildDemoData();
  const owner = (k: OwnerKey) => ids[k];

  await prisma.$transaction(
    async (tx) => {
      if (options.reset) {
        // 仅清空演示组织的业务数据 / wipe business data of the demo organization only
        await tx.note.deleteMany({ where: { organizationId: o } });
        await tx.activity.deleteMany({ where: { organizationId: o } });
        await tx.lead.updateMany({ where: { organizationId: o }, data: { convertedAccountId: null, convertedContactId: null, convertedDealId: null } });
        await tx.deal.deleteMany({ where: { organizationId: o } });
        await tx.contact.deleteMany({ where: { organizationId: o } });
        await tx.account.deleteMany({ where: { organizationId: o } });
        await tx.lead.deleteMany({ where: { organizationId: o } });
        // 明细已随商机级联删除，产品随后可删 / line items cascaded with deals, so products can go
        await tx.product.deleteMany({ where: { organizationId: o } });
      }

      await tx.product.createMany({ data: data.products.map((p) => ({ ...p, organizationId: o })) });
      const productIds = new Map(
        (await tx.product.findMany({ where: { organizationId: o }, select: { id: true, sku: true } })).map((p) => [p.sku, p.id]),
      );

      const accountIds: Record<string, string> = {};
      for (const a of data.accounts) {
        const created = await tx.account.create({
          data: {
            organizationId: o,
            ownerId: owner(a.owner),
            name: a.name,
            industry: a.industry,
            phone: a.phone,
            website: `https://www.${a.domain}`,
            address: `${a.region} · ${a.city}`,
            description: `虚构演示客户。主要采购：${a.products.join(' / ')}`,
          },
        });
        accountIds[a.key] = created.id;
        await tx.contact.createMany({
          data: a.contacts.map((c, i) => ({
            organizationId: o,
            accountId: created.id,
            name: `【演示】${c.name}`,
            title: c.title,
            email: `${c.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') || `contact${i + 1}`}@${a.domain}`,
            phone: a.phone.replace(/\d{2}$/, String(10 + i)),
            isPrimary: i === 0,
          })),
        });
      }

      const dealIds: Record<string, string> = {};
      for (const d of data.deals) {
        const created = await tx.deal.create({
          data: {
            organizationId: o,
            ownerId: owner(d.owner),
            accountId: accountIds[d.account]!,
            name: d.name,
            amount: d.amount,
            currency: d.currency,
            stage: d.stage,
            expectedCloseDate: dayOffset(d.closeInDays),
            description: d.description,
            createdAt: new Date(Date.now() - (Math.abs(d.closeInDays) % 50 + 20) * DAY),
          },
        });
        dealIds[d.key] = created.id;
      }

      const catalog = new Map(data.products.map((p) => [p.sku, p]));
      await tx.dealLineItem.createMany({
        data: data.items.map((it) => ({
          organizationId: o,
          dealId: dealIds[it.deal]!,
          productId: productIds.get(it.sku)!,
          productName: catalog.get(it.sku)!.name,
          productSku: it.sku,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discountPercent: it.discountPercent,
          lineTotal: it.lineTotal,
        })),
      });

      // 报价单：明细复制自商机明细，报价单号按年份顺序编号 / quotes: lines copied from the deal items, numbered per year
      const year = new Date().getUTCFullYear();
      const units = new Map(data.products.map((p) => [p.sku, p.unit]));
      const dealOwner = new Map(data.deals.map((d) => [d.key, d.owner]));
      const ordered = [...data.quotes].sort((a, b) => b.daysAgo - a.daysAgo);
      for (const [n, q] of ordered.entries()) {
        const created = new Date(Date.now() - q.daysAgo * DAY);
        const quote = await tx.quote.create({
          data: {
            organizationId: o,
            dealId: dealIds[q.deal]!,
            quoteNumber: `QT-${year}-${String(n + 1).padStart(4, '0')}`,
            subject: data.deals.find((d) => d.key === q.deal)!.name,
            status: q.status,
            currency: data.deals.find((d) => d.key === q.deal)!.currency,
            validUntil: dayOffset(q.validInDays),
            taxPercent: q.taxPercent,
            subtotal: q.subtotal,
            taxAmount: q.taxAmount,
            total: q.total,
            terms: q.terms,
            createdById: owner(dealOwner.get(q.deal)!),
            sentAt: q.status === 'DRAFT' ? null : new Date(created.getTime() + DAY),
            decidedAt: q.status === 'ACCEPTED' || q.status === 'REJECTED' ? new Date(created.getTime() + 5 * DAY) : null,
            createdAt: created,
          },
        });
        await tx.quoteLineItem.createMany({
          data: data.items
            .filter((it) => it.deal === q.deal)
            .map((it, k) => ({
              organizationId: o,
              quoteId: quote.id,
              position: k + 1,
              productSku: it.sku,
              productName: catalog.get(it.sku)!.name,
              unit: units.get(it.sku)!,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              discountPercent: it.discountPercent,
              lineTotal: it.lineTotal,
            })),
        });
      }

      const leadIds: string[] = [];
      for (const l of data.leads) {
        const created = await tx.lead.create({
          data: {
            organizationId: o,
            ownerId: owner(l.owner),
            name: l.name,
            company: l.company,
            title: l.title,
            email: l.email,
            phone: l.phone,
            source: l.source,
            status: l.status,
            description: l.description,
            createdAt: new Date(Date.now() - l.daysAgo * DAY),
          },
        });
        leadIds.push(created.id);
      }

      await tx.note.createMany({
        data: data.notes.map((n) => ({
          organizationId: o,
          authorId: owner(n.owner),
          content: `【演示】${n.content}`,
          dealId: n.deal ? dealIds[n.deal] : null,
          accountId: n.account ? accountIds[n.account] : null,
          createdAt: new Date(Date.now() - n.daysAgo * DAY),
        })),
      });

      await tx.activity.createMany({
        data: data.activities.map((a) => ({
          organizationId: o,
          ownerId: owner(a.owner),
          type: a.type,
          subject: a.subject,
          content: a.content,
          dealId: a.deal ? dealIds[a.deal] : null,
          accountId: a.account ? accountIds[a.account] : null,
          leadId: a.lead !== undefined ? leadIds[a.lead] : null,
          dueAt: a.dueInDays === null ? null : new Date(dayOffset(a.dueInDays).getTime() + 10 * 3600_000),
          completed: a.completed,
          completedAt: a.completed ? new Date(Date.now() - Math.max(0, a.daysAgo - 1) * DAY) : null,
          createdAt: new Date(Date.now() - a.daysAgo * DAY),
        })),
      });
    },
    { timeout: 60_000 },
  );

  console.log(
    `演示数据已${options.reset ? '重建' : '创建'}：${data.accounts.length} 客户、${data.accounts.reduce((n, a) => n + a.contacts.length, 0)} 联系人、` +
      `${data.leads.length} 线索、${data.deals.length} 商机、${data.activities.length} 跟进、${data.notes.length} 备注、${data.products.length} 产品、${data.items.length} 产品明细、${data.quotes.length} 报价单 / demo data ready`,
  );
}

// 直接运行时执行 / run when executed directly
if (process.argv[1]?.endsWith('seed-demo.ts')) {
  await seedDemo({ reset: process.argv.includes('--reset') });
  await prisma.$disconnect();
}
