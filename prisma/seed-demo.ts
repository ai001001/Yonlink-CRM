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
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../src/server/db';
import { removeOrganizationFiles, saveFile } from '../src/server/storage';
import { buildDemoData, dealCreatedDaysAgo, demoAttachments, demoDuplicates, DEMO_ORG_NAME, DEMO_TAGS, DEMO_TARGET_MONTHS, DEMO_TARGETS, demoTagAssignments, demoTagId, demoTargetAmount, DEMO_USERS, LEGACY_DEMO_ORG_NAMES, type OwnerKey } from './demo-data';

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

  // 重置时先删除演示组织的旧附件文件（附件记录随业务数据删除）/ on reset, delete the demo organization's old files first
  if (options.reset) await removeOrganizationFiles(o);
  const files: { id: string; data: Buffer }[] = [];
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
        // 标签关联已随记录级联删除 / tag assignments cascaded with the records
        await tx.tag.deleteMany({ where: { organizationId: o } });
        // 回收站中的旧快照对应已不存在的旧数据，一并清空 / old snapshots refer to the wiped data
        await tx.recycleBinItem.deleteMany({ where: { organizationId: o } });
        await tx.salesTarget.deleteMany({ where: { organizationId: o } });
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
            createdAt: new Date(Date.now() - dealCreatedDaysAgo(d) * DAY),
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
            // 演示转化结果：关联客户与商机，转化时间 = 商机创建时间 / demo conversion: linked account and deal, converted when the deal was created
            ...(l.convertedDeal
              ? {
                  convertedAccountId: accountIds[data.deals.find((d) => d.key === l.convertedDeal)!.account],
                  convertedDealId: dealIds[l.convertedDeal],
                  convertedAt: new Date(Date.now() - dealCreatedDaysAgo(data.deals.find((d) => d.key === l.convertedDeal)!) * DAY),
                }
              : {}),
          },
        });
        leadIds.push(created.id);
      }

      // 附件元数据（文件在事务提交后写入）/ attachment metadata (files are written after the commit)
      for (const att of demoAttachments(data)) {
        const id = randomUUID();
        const body = Buffer.from((att.contentType === 'text/csv' ? '\uFEFF' : '') + att.content, 'utf8');
        const parent =
          att.entity === 'lead'
            ? { leadId: leadIds[att.ref as number]!, owner: data.leads[att.ref as number]!.owner }
            : att.entity === 'account'
              ? { accountId: accountIds[att.ref as string]!, owner: data.accounts.find((a) => a.key === att.ref)!.owner }
              : { dealId: dealIds[att.ref as string]!, owner: data.deals.find((d) => d.key === att.ref)!.owner };
        const { owner: ownerKey, ...link } = parent;
        await tx.attachment.create({
          data: {
            id,
            organizationId: o,
            ...link,
            fileName: att.fileName,
            contentType: att.contentType,
            size: body.byteLength,
            sha256: createHash('sha256').update(body).digest('hex'),
            uploadedById: owner(ownerKey),
          },
        });
        files.push({ id, data: body });
      }

      // 演示用的重复记录（查重合并）/ demo duplicates for deduplication
      const dups = demoDuplicates(data);
      for (const l of dups.leads) {
        await tx.lead.create({
          data: {
            organizationId: o,
            ownerId: owner(l.owner),
            name: l.name,
            company: l.company,
            title: l.title,
            email: l.email,
            phone: l.phone,
            source: l.source,
            status: l.status === 'CONVERTED' ? 'NEW' : l.status,
            description: l.description,
            createdAt: new Date(Date.now() - l.daysAgo * DAY),
          },
        });
      }
      for (const d of dups.accounts) {
        const src = data.accounts.find((a) => a.key === d.of)!;
        const dupAccount = await tx.account.create({
          data: { organizationId: o, ownerId: owner(src.owner), name: d.name, industry: src.industry, phone: d.phone, website: d.website, description: '重复录入：同一客户的第二条记录。', createdAt: new Date(Date.now() - DAY) },
        });
        // 重复客户也录入了同样的前两位联系人（第一位为主要联系人）/ the duplicate repeats the first two contacts (first is primary)
        await tx.contact.createMany({
          data: src.contacts.slice(0, 2).map((c, i) => ({
            organizationId: o,
            accountId: dupAccount.id,
            name: `【演示】${c.name}`,
            title: c.title,
            email: `dup${i + 1}@${src.domain}`,
            phone: src.phone,
            isPrimary: i === 0,
          })),
        });
      }

      // 销售目标：按月（当月 1 日，UTC）/ monthly sales targets (first day of the month, UTC)
      const now = new Date();
      await tx.salesTarget.createMany({
        data: DEMO_TARGETS.flatMap((target) =>
          DEMO_TARGET_MONTHS.map((offset) => ({
            organizationId: o,
            userId: owner(target.owner),
            month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)),
            currency: target.currency,
            amount: demoTargetAmount(target.base, offset),
          })),
        ),
      });

      // 标签 / tags
      const tagIds: Record<string, string> = {};
      for (const tag of DEMO_TAGS) {
        tagIds[tag.key] = (await tx.tag.create({ data: { id: demoTagId(o, tag.key), organizationId: o, name: tag.name, nameKey: tag.name.toLowerCase(), color: tag.color } })).id;
      }
      // 视图中仍指向已不存在标签的筛选条件去掉（如用户在演示中自建、重置后已删除的标签）
      // drop view tag filters that point at tags which no longer exist (e.g. user-made demo tags wiped by the reset)
      await tx.$executeRaw`
        UPDATE saved_views SET filters = filters - 'tagId', updated_at = now()
        WHERE organization_id = ${o}::uuid AND filters ? 'tagId'
          AND NOT EXISTS (SELECT 1 FROM tags WHERE tags.organization_id = ${o}::uuid AND tags.id::text = saved_views.filters->>'tagId')`;
      const assigned = demoTagAssignments(data);
      await tx.accountTag.createMany({ data: assigned.accounts.map((x) => ({ organizationId: o, accountId: accountIds[x.account]!, tagId: tagIds[x.tag]! })) });
      await tx.dealTag.createMany({ data: assigned.deals.map((x) => ({ organizationId: o, dealId: dealIds[x.deal]!, tagId: tagIds[x.tag]! })) });
      await tx.leadTag.createMany({ data: assigned.leads.map((x) => ({ organizationId: o, leadId: leadIds[x.lead]!, tagId: tagIds[x.tag]! })) });

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
        data: data.activities.map((a, i) => ({
          organizationId: o,
          ownerId: owner(a.owner),
          type: a.type,
          subject: a.subject,
          content: a.content,
          dealId: a.deal ? dealIds[a.deal] : null,
          accountId: a.account ? accountIds[a.account] : null,
          leadId: a.lead !== undefined ? leadIds[a.lead] : null,
          // 截止时间分布在北京时间 09:00–17:30（UTC 01:00–09:30）/ due times spread over 09:00–17:30 Beijing time
          dueAt: a.dueInDays === null ? null : new Date(dayOffset(a.dueInDays).getTime() + (1 + (i % 9)) * 3600_000 + (i % 2) * 1800_000),
          completed: a.completed,
          completedAt: a.completed ? new Date(Date.now() - Math.max(0, a.daysAgo - 1) * DAY) : null,
          createdAt: new Date(Date.now() - a.daysAgo * DAY),
        })),
      });
    },
    { timeout: 60_000 },
  );
  // 事务提交后写入附件文件 / write attachment files after the commit
  for (const f of files) await saveFile(o, f.id, f.data);

  console.log(
    `演示数据已${options.reset ? '重建' : '创建'}：${data.accounts.length + 1} 客户（含 1 条重复）、${data.accounts.reduce((n, a) => n + a.contacts.length, 0) + 2} 联系人、` +
      `${data.leads.length + 2} 线索（含 2 条重复）、${data.deals.length} 商机、${data.activities.length} 跟进、${data.notes.length} 备注、${data.products.length} 产品、${data.items.length} 产品明细、${data.quotes.length} 报价单、${DEMO_TAGS.length} 标签、${files.length} 附件、${DEMO_TARGETS.length * DEMO_TARGET_MONTHS.length} 条销售目标 / demo data ready`,
  );
}

// 直接运行时执行 / run when executed directly
if (process.argv[1]?.endsWith('seed-demo.ts')) {
  await seedDemo({ reset: process.argv.includes('--reset') });
  await prisma.$disconnect();
}
