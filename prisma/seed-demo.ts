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
import { toBase } from '../src/server/modules/exchange-rates';
import { approvalReasons, approvalSteps } from '../src/server/modules/approvals';
import { Prisma } from '../src/generated/prisma/client';
import { buildDemoData, dealCreatedDaysAgo, demoStagePath, demoAttachments, demoDuplicates, DEMO_CAMPAIGNS, demoCampaignFor, demoContactRoles, demoDealCompetitors, demoTickets, DEMO_TICKET_COMMENTS, DEMO_SLA_HOURS, DEMO_KB_ARTICLES, DEMO_PRICE_BOOKS, DEMO_PURCHASE_ORDERS, DEMO_SCORING, DEMO_ACCOUNT_SCORING, DEMO_CONTACT_SCORING, DEMO_DEAL_SCORING, DEMO_ASSIGNMENT_RULES, DEMO_WEB_FORMS, DEMO_WORKFLOWS, DEMO_APPROVAL, DEMO_WEBHOOK, DEMO_VALIDATION_RULES, DEMO_CUSTOM_FIELDS, DEMO_VENDORS, DEMO_RATES, demoRateOn, demoInvoices, demoNotifications, demoOrders, DEMO_ORG_NAME, DEMO_TAGS, DEMO_TARGET_MONTHS, DEMO_TARGETS, demoTagAssignments, demoTagId, demoTargetAmount, DEMO_USERS, LEGACY_DEMO_ORG_NAMES, type OwnerKey } from './demo-data';

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
        await tx.notification.deleteMany({ where: { organizationId: o } });
        // 发票引用订单，订单引用报价单与商机（RESTRICT），须先删除 / invoices → orders → quotes/deals (RESTRICT) go first
        await tx.invoice.deleteMany({ where: { organizationId: o } });
        // 采购单引用销售订单与供应商，须先删除；单据编号计数器一并重置 / purchase orders reference sales orders and vendors, so they go first; reset the counters too
        await tx.purchaseOrder.deleteMany({ where: { organizationId: o } });
        await tx.vendor.deleteMany({ where: { organizationId: o } });
        await tx.documentCounter.deleteMany({ where: { organizationId: o } });
        // 客户引用价格表，先清除再删除价格表（产品价格、阶梯随之删除）/ accounts reference price books: clear, then delete (entries and tiers cascade)
        await tx.account.updateMany({ where: { organizationId: o }, data: { priceBookId: null } });
        await tx.priceBook.deleteMany({ where: { organizationId: o } });
        await tx.salesOrder.deleteMany({ where: { organizationId: o } });
        await tx.note.deleteMany({ where: { organizationId: o } });
        await tx.activity.deleteMany({ where: { organizationId: o } });
        await tx.lead.updateMany({ where: { organizationId: o }, data: { convertedAccountId: null, convertedContactId: null, convertedDealId: null } });
        await tx.deal.deleteMany({ where: { organizationId: o } });
        // 工单引用客户（RESTRICT）与联系人，须先删除；工单号计数器一并重置 / tickets reference accounts (RESTRICT) and contacts, so they go first; reset the number counter too
        await tx.ticket.deleteMany({ where: { organizationId: o } });
        // 文章与工单的关联随工单删除，文章随后可删 / article links went with the tickets; articles can go now
        await tx.kbArticle.deleteMany({ where: { organizationId: o } });
        await tx.ticketCounter.deleteMany({ where: { organizationId: o } });
        await tx.ticketSlaPolicy.deleteMany({ where: { organizationId: o } });
        await tx.contact.deleteMany({ where: { organizationId: o } });
        await tx.account.deleteMany({ where: { organizationId: o } });
        await tx.lead.deleteMany({ where: { organizationId: o } });
        // 明细已随商机级联删除，产品随后可删 / line items cascaded with deals, so products can go
        // 库存流水限制删除产品，先删除 / stock movements restrict product deletion, so they go first
        await tx.stockMovement.deleteMany({ where: { organizationId: o } });
        await tx.product.deleteMany({ where: { organizationId: o } });
        // 标签关联已随记录级联删除 / tag assignments cascaded with the records
        await tx.tag.deleteMany({ where: { organizationId: o } });
        // 回收站中的旧快照对应已不存在的旧数据，一并清空 / old snapshots refer to the wiped data
        await tx.recycleBinItem.deleteMany({ where: { organizationId: o } });
        await tx.salesTarget.deleteMany({ where: { organizationId: o } });
        await tx.exchangeRate.deleteMany({ where: { organizationId: o } });
        await tx.scoringRule.deleteMany({ where: { organizationId: o } });
        await tx.scoringSettings.deleteMany({ where: { organizationId: o } });
        await tx.assignmentRule.deleteMany({ where: { organizationId: o } });
        await tx.workflowRule.deleteMany({ where: { organizationId: o } });
        await tx.webhook.deleteMany({ where: { organizationId: o } });
        await tx.validationRule.deleteMany({ where: { organizationId: o } });
        await tx.customField.deleteMany({ where: { organizationId: o } });
        await tx.apiKey.deleteMany({ where: { organizationId: o } });
        await tx.quoteApprovalSettings.deleteMany({ where: { organizationId: o } });
        await tx.quoteApprovalLevel.deleteMany({ where: { organizationId: o } });
        // 网页表单引用市场活动，先删除 / web forms reference campaigns, so they go first
        await tx.webForm.deleteMany({ where: { organizationId: o } });
        // 线索、商机已删除，活动可删 / leads and deals are gone, so campaigns can go
        await tx.campaign.deleteMany({ where: { organizationId: o } });
        // 演示账号的工作台布局恢复默认 / demo users' dashboard layouts back to default
        await tx.userDashboardLayout.deleteMany({ where: { organizationId: o } });
      }

      // 评分规则先于业务数据写入：线索、客户、联系人及其关联记录写入时由触发器计算分数
      // scoring rules before business data: triggers score leads, accounts and contacts as they and related records are written
      for (const [entity, setup] of [
        ['LEAD', DEMO_SCORING],
        ['ACCOUNT', DEMO_ACCOUNT_SCORING],
        ['CONTACT', DEMO_CONTACT_SCORING],
        ['DEAL', DEMO_DEAL_SCORING],
      ] as const) {
        await tx.scoringRule.createMany({
          data: setup.rules.map((r, position) => ({ organizationId: o, entity, kind: r.kind, field: r.field ?? null, value: r.value ?? null, maxCount: r.maxCount ?? null, points: r.points, position })),
        });
        await tx.scoringSettings.create({ data: { organizationId: o, entity, hotScore: setup.hotScore, warmScore: setup.warmScore } });
      }

      // 线索分配规则（负责人为演示销售）/ lead assignment rules (assigned to the demo sales users)
      for (const [position, r] of DEMO_ASSIGNMENT_RULES.entries()) {
        await tx.assignmentRule.create({
          data: {
            organizationId: o,
            name: r.name,
            conditions: r.conditions,
            position,
            users: { create: r.users.map((k, p) => ({ userId: owner(k)!, position: p })) },
          },
        });
      }

      // 市场活动（线索与商机引用，先写入）/ campaigns first (leads and deals reference them)
      const campaignIds: Record<string, string> = {};
      for (const c of DEMO_CAMPAIGNS) {
        const row = await tx.campaign.create({
          data: {
            organizationId: o,
            name: c.name,
            type: c.type,
            status: c.status,
            startDate: dayOffset(c.startIn),
            endDate: dayOffset(c.endIn),
            currency: c.currency,
            budget: c.budget,
            actualCost: c.actualCost,
            description: '【演示】虚构市场活动，数据仅用于演示。',
            ownerId: ids[c.owner],
          },
        });
        campaignIds[c.key] = row.id;
      }

      // 汇率（发票快照依赖，先写入）/ exchange rates first (invoice snapshots depend on them)
      await tx.exchangeRate.createMany({
        data: DEMO_RATES.map((r) => ({ organizationId: o, currency: r.currency, rate: r.rate, effectiveDate: dayOffset(-r.daysAgo), createdById: ids.admin })),
      });

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
      // 阶段历史：以演示推进路径替换触发器写入的新建行（修改人为商机负责人）
      // stage history: replace the trigger's creation rows with the demo stage paths (actor = deal owner)
      await tx.dealStageHistory.deleteMany({ where: { organizationId: o } });
      await tx.dealStageHistory.createMany({
        data: data.deals.flatMap((d) =>
          demoStagePath(d).map((s) => ({
            organizationId: o,
            dealId: dealIds[d.key]!,
            stage: s.stage,
            amount: d.amount,
            currency: d.currency,
            expectedCloseDate: dayOffset(d.closeInDays),
            changedById: owner(d.owner),
            changedAt: new Date(Date.now() - s.daysAgo * DAY),
          })),
        ),
      });

      // 商机竞争对手与联系人角色 / deal competitors and contact roles
      const competitors = demoDealCompetitors(data);
      await tx.dealCompetitor.createMany({
        data: competitors.map((c) => ({ organizationId: o, dealId: dealIds[c.deal]!, name: c.competitor.name, threatLevel: c.competitor.threatLevel, strengths: c.competitor.strengths, weaknesses: c.competitor.weaknesses })),
      });
      const contactIds = new Map(
        (await tx.contact.findMany({ where: { organizationId: o }, select: { id: true, name: true, accountId: true } })).map((c) => [`${c.accountId}|${c.name}`, c.id]),
      );
      const roles = demoContactRoles(data);
      await tx.dealContactRole.createMany({
        data: roles.map((r) => {
          const deal = data.deals.find((d) => d.key === r.deal)!;
          const contact = data.accounts.find((a) => a.key === deal.account)!.contacts[r.contactIndex]!;
          return { organizationId: o, dealId: dealIds[r.deal]!, contactId: contactIds.get(`${accountIds[deal.account]}|【演示】${contact.name}`)!, role: r.role, isPrimary: r.isPrimary };
        }),
      });

      // 服务工单（工单号按创建先后编号，计数器同步）/ service tickets (numbered by creation order; counter kept in sync)
      const tickets = demoTickets(data).sort((x, y) => y.ageDays - x.ageDays);
      const ticketYear = new Date().getUTCFullYear();
      for (const [i, tk] of tickets.entries()) {
        const accountId = accountIds[tk.account]!;
        const contact = await tx.contact.findFirst({ where: { organizationId: o, accountId }, orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }], select: { id: true } });
        const created = new Date(Date.now() - tk.ageDays * DAY - 3_600_000);
        const done = tk.status === 'RESOLVED' || tk.status === 'CLOSED';
        const ticket = await tx.ticket.create({
          data: {
            organizationId: o,
            ticketNumber: `CS-${ticketYear}-${String(i + 1).padStart(4, '0')}`,
            subject: tk.subject,
            description: '虚构演示工单，用于展示服务工单的处理流程。',
            accountId,
            contactId: contact?.id ?? null,
            ownerId: owner(tk.owner),
            status: tk.status,
            priority: tk.priority,
            type: tk.type,
            channel: tk.channel,
            dueAt: new Date(Date.now() + tk.dueInHours * 3_600_000),
            resolution: tk.resolution,
            resolvedAt: done ? new Date(Math.min(Date.now(), created.getTime() + 2 * DAY)) : null,
            createdAt: created,
          },
        });
        // 处理往来（作者为工单负责人；不超过当前时间）/ comments by the ticket owner, never in the future
        const comments = DEMO_TICKET_COMMENTS[tk.subject] ?? [];
        await tx.ticketComment.createMany({
          data: comments.map((c) => ({
            organizationId: o,
            ticketId: ticket.id,
            authorId: owner(tk.owner),
            body: c.body,
            isInternal: c.isInternal,
            createdAt: new Date(Math.min(Date.now() - 60_000, created.getTime() + c.hoursAfter * 3_600_000)),
          })),
        });
      }
      // 知识库文章与工单关联（关联人为工单负责人）/ knowledge-base articles and ticket links (linked by the ticket owner)
      for (const art of DEMO_KB_ARTICLES) {
        const when = new Date(Date.now() - art.daysAgo * DAY);
        const created = await tx.kbArticle.create({
          data: {
            organizationId: o,
            title: art.title,
            body: art.body,
            category: art.category,
            status: art.status,
            authorId: owner(art.author),
            publishedAt: art.status === 'DRAFT' ? null : when,
            viewCount: art.views,
            createdAt: when,
          },
        });
        for (const subject of art.tickets) {
          const tk = await tx.ticket.findFirst({ where: { organizationId: o, subject }, select: { id: true, ownerId: true } });
          if (tk?.ownerId) await tx.ticketArticle.create({ data: { organizationId: o, ticketId: tk.id, articleId: created.id, linkedById: tk.ownerId } });
        }
      }

      // 演示 SLA：默认时限，升级接收人为郑经理；已逾期的演示工单会在首次查看时升级
      // demo SLA: default limits, escalations go to the manager; overdue demo tickets escalate when first viewed
      await tx.ticketSlaPolicy.create({ data: { organizationId: o, enabled: true, ...DEMO_SLA_HOURS, escalateToId: owner('manager') } });
      await tx.ticketCounter.create({ data: { organizationId: o, year: ticketYear, last: tickets.length } });

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

      // 销售订单：由已接受的报价单生成，明细与金额复制自报价单 / sales orders from accepted quotes, copying lines and amounts
      const acceptedQuotes = new Map(
        (await tx.quote.findMany({ where: { organizationId: o, status: 'ACCEPTED' }, include: { lines: true, deal: { select: { account: { select: { address: true } } } } } })).map(
          (q) => [q.dealId, q],
        ),
      );
      for (const [n, so] of demoOrders(data).entries()) {
        const q = acceptedQuotes.get(dealIds[so.deal]!)!;
        const created = new Date(Date.now() - so.daysAgo * DAY);
        const at = (fraction: number) => new Date(created.getTime() + so.daysAgo * fraction * DAY);
        const order = await tx.salesOrder.create({
          data: {
            organizationId: o,
            quoteId: q.id,
            dealId: q.dealId,
            orderNumber: `SO-${year}-${String(n + 1).padStart(4, '0')}`,
            subject: q.subject,
            status: so.status,
            currency: q.currency,
            taxPercent: q.taxPercent,
            subtotal: q.subtotal,
            taxAmount: q.taxAmount,
            total: q.total,
            expectedDelivery: dayOffset(so.expectedInDays),
            shippingAddress: q.deal.account.address,
            notes: '【演示】请随货附带产品合格证与装箱单。',
            cancelReason: so.cancelReason ?? null,
            createdById: q.createdById,
            shippedAt: so.status === 'SHIPPED' || so.status === 'DELIVERED' ? at(0.3) : null,
            deliveredAt: so.status === 'DELIVERED' ? at(0.7) : null,
            cancelledAt: so.status === 'CANCELLED' ? at(0.5) : null,
            createdAt: created,
          },
        });
        await tx.salesOrderLineItem.createMany({
          data: q.lines.map((l) => ({
            organizationId: o,
            salesOrderId: order.id,
            position: l.position,
            productSku: l.productSku,
            productName: l.productName,
            unit: l.unit,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPercent: l.discountPercent,
            lineTotal: l.lineTotal,
          })),
        });
      }

      // 发票：明细与金额复制自订单；收款按比例，付清时最后一笔补齐余额 / invoices copy order lines and amounts; payments by share
      const activeOrders = new Map(
        (await tx.salesOrder.findMany({ where: { organizationId: o, status: { in: ['SHIPPED', 'DELIVERED'] } }, include: { lines: true } })).map((so) => [so.dealId, so]),
      );
      for (const [n, inv] of demoInvoices(data).entries()) {
        const so = activeOrders.get(dealIds[inv.deal]!)!;
        const invoiceDate = dayOffset(-inv.daysAgo);
        const totalCents = Math.round(Number(so.total) * 100);
        let paidCents = 0;
        const payments = inv.payments.map((p, k) => {
          const settles = k === inv.payments.length - 1 && inv.payments.reduce((sum, x) => sum + x.share, 0) === 1;
          const amount = settles ? totalCents - paidCents : Math.round(totalCents * p.share);
          paidCents += amount;
          return { ...p, amount: (amount / 100).toFixed(2), paidOn: dayOffset(-inv.daysAgo + p.afterDays) };
        });
        const paid = paidCents === totalCents;
        const invoice = await tx.invoice.create({
          data: {
            organizationId: o,
            salesOrderId: so.id,
            dealId: so.dealId,
            invoiceNumber: `INV-${year}-${String(n + 1).padStart(4, '0')}`,
            subject: so.subject,
            status: paid ? 'PAID' : paidCents > 0 ? 'PARTIALLY_PAID' : 'UNPAID',
            currency: so.currency,
            taxPercent: so.taxPercent,
            subtotal: so.subtotal,
            taxAmount: so.taxAmount,
            total: so.total,
            paidAmount: (paidCents / 100).toFixed(2),
            ...(() => {
              // 开票日汇率快照 / rate snapshot on the invoice date
              const rate = demoRateOn(so.currency, inv.daysAgo);
              return { exchangeRate: rate, baseTotal: rate ? toBase(so.total, new Prisma.Decimal(rate)) : null };
            })(),
            invoiceDate,
            dueDate: dayOffset(-inv.daysAgo + inv.termDays),
            billingAddress: so.shippingAddress,
            notes: '【演示】请在到期日前付款，汇款时注明发票号。',
            createdById: so.createdById,
            paidAt: paid ? payments.at(-1)!.paidOn : null,
            createdAt: invoiceDate,
          },
        });
        await tx.invoiceLineItem.createMany({
          data: so.lines.map((l) => ({
            organizationId: o,
            invoiceId: invoice.id,
            position: l.position,
            productSku: l.productSku,
            productName: l.productName,
            unit: l.unit,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPercent: l.discountPercent,
            lineTotal: l.lineTotal,
          })),
        });
        await tx.invoicePayment.createMany({
          data: payments.map((p) => ({
            organizationId: o,
            invoiceId: invoice.id,
            amount: p.amount,
            paidOn: p.paidOn,
            method: p.method,
            reference: p.reference,
            recordedById: so.createdById,
            createdAt: p.paidOn,
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
            campaignId: demoCampaignFor(l.source) ? campaignIds[demoCampaignFor(l.source)!] : null,
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
      // 网页表单：关联来源为网站的演示线索，提交次数与最近提交时间与之一致 / web forms linked to website demo leads with matching counters
      const websiteLeads = data.leads.map((l, i) => ({ l, id: leadIds[i]! })).filter((x) => x.l.source === 'WEBSITE');
      let linked = 0;
      for (const f of DEMO_WEB_FORMS) {
        const leads = websiteLeads.slice(linked, linked + f.linkLeads);
        linked += leads.length;
        const last = leads.length ? Math.min(...leads.map((x) => x.l.daysAgo)) : null;
        const form = await tx.webForm.create({
          data: {
            organizationId: o,
            name: f.name,
            publicKey: randomBytes(32).toString('base64url'),
            isActive: f.isActive,
            title: f.title,
            intro: f.intro,
            fields: f.fields,
            requiredFields: f.requiredFields,
            source: f.source,
            ownerId: f.assignByRule ? null : owner('manager'),
            assignByRule: f.assignByRule,
            campaignId: f.campaign ? campaignIds[f.campaign] : null,
            successMessage: f.successMessage,
            submissionCount: leads.length,
            lastSubmittedAt: last === null ? null : new Date(Date.now() - last * DAY),
            createdById: ids.admin,
          },
        });
        if (leads.length) await tx.lead.updateMany({ where: { id: { in: leads.map((x) => x.id) } }, data: { webFormId: form.id } });
      }

      // 转化生成的商机沿用线索的来源活动 / deals converted from campaign leads keep the campaign
      for (const l of data.leads) {
        const key = demoCampaignFor(l.source);
        if (key && l.convertedDeal) await tx.deal.update({ where: { id: dealIds[l.convertedDeal]! }, data: { campaignId: campaignIds[key] } });
      }

      // 供应商与采购单（采购单价约为目录售价的 55%；下单日汇率按演示汇率）/ vendors and purchase orders (costs ~55% of list price; demo rates on the order day)
      const vendorIds: Record<string, string> = {};
      for (const v of DEMO_VENDORS) {
        vendorIds[v.key] = (await tx.vendor.create({ data: { organizationId: o, name: v.name, contactName: v.contactName, phone: v.phone, currency: v.currency, paymentTerms: v.paymentTerms, isActive: v.isActive } })).id;
      }
      const firstOrder = await tx.salesOrder.findFirst({ where: { organizationId: o }, orderBy: { orderNumber: 'asc' }, select: { id: true, shippingAddress: true } });
      const poYear = new Date().getUTCFullYear();
      for (const [n, po] of DEMO_PURCHASE_ORDERS.entries()) {
        const vendor = DEMO_VENDORS.find((v) => v.key === po.vendor)!;
        const created = new Date(Date.now() - po.daysAgo * DAY);
        const lines = po.lines.map((l, i) => {
          const p = data.products.find((x) => x.sku === l.sku)!;
          const unitCost = new Prisma.Decimal(p.unitPrice).mul('0.55').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
          return { organizationId: o, position: i + 1, productSku: p.sku, productName: p.name, unit: p.unit, quantity: l.quantity, receivedQuantity: l.received, unitCost, lineTotal: unitCost.mul(l.quantity) };
        });
        const subtotal = lines.reduce((sum, l) => sum.plus(l.lineTotal), new Prisma.Decimal(0));
        const taxAmount = subtotal.mul(po.taxPercent).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        const total = subtotal.plus(taxAmount);
        const ordered = po.status !== 'DRAFT';
        const rate = ordered ? demoRateOn(vendor.currency, po.daysAgo) : null;
        const createdPo = await tx.purchaseOrder.create({
          data: {
            organizationId: o,
            poNumber: `PO-${poYear}-${String(n + 1).padStart(4, '0')}`,
            vendorId: vendorIds[po.vendor]!,
            salesOrderId: po.linkFirstSalesOrder ? (firstOrder?.id ?? null) : null,
            subject: po.subject,
            status: po.status,
            currency: vendor.currency,
            taxPercent: po.taxPercent,
            subtotal,
            taxAmount,
            total,
            exchangeRate: rate,
            baseTotal: rate ? total.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) : null,
            expectedDate: dayOffset(po.expectedInDays),
            deliveryAddress: po.linkFirstSalesOrder ? (firstOrder?.shippingAddress ?? null) : '【演示】宁波市北仑区演示仓库',
            notes: '【演示】虚构采购单，用于展示采购流程。',
            createdById: owner('manager'),
            orderedAt: ordered ? new Date(created.getTime() + 3_600_000) : null,
            receivedAt: po.status === 'RECEIVED' ? new Date(created.getTime() + 15 * DAY) : null,
            createdAt: created,
          },
        });
        await tx.purchaseOrderLineItem.createMany({ data: lines.map((l) => ({ ...l, purchaseOrderId: createdPo.id })) });
      }
      await tx.documentCounter.create({ data: { organizationId: o, kind: 'PO', year: poYear, last: DEMO_PURCHASE_ORDERS.length } });

      // 价格表：产品价格按目录价折算，指定给客户 / price books: entries from the catalogue price, assigned to accounts
      for (const pb of DEMO_PRICE_BOOKS) {
        const book = await tx.priceBook.create({ data: { organizationId: o, name: pb.name, currency: pb.currency, pricingModel: pb.pricingModel, isActive: pb.isActive, description: pb.description } });
        if (pb.tiers.length) await tx.priceBookTier.createMany({ data: pb.tiers.map((t) => ({ ...t, organizationId: o, priceBookId: book.id })) });
        const ratio = pb.ratio;
        if (ratio) {
          const products = await tx.product.findMany({ where: { organizationId: o, currency: pb.currency, isActive: true }, select: { id: true, unitPrice: true } });
          await tx.priceBookEntry.createMany({
            data: products.map((p) => ({ organizationId: o, priceBookId: book.id, productId: p.id, listPrice: p.unitPrice.mul(ratio).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) })),
          });
        }
        if (pb.accounts.length) await tx.account.updateMany({ where: { id: { in: pb.accounts.map((k) => accountIds[k]!) } }, data: { priceBookId: book.id } });
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

      // 库存（演示数据）：期初库存 → 采购收货 → 销售发货，按时间顺序写入流水，余额由触发器计算；部分产品设置再订货水平
      // stock (demo data): opening stock → purchase receipts → shipments, written in time order so the trigger computes
      // balances; some products get a reorder level
      const products = await tx.product.findMany({ where: { organizationId: o }, orderBy: { sku: 'asc' } });
      const productBySku = new Map(products.map((p) => [p.sku, p]));
      const events: { at: Date; productId: string; reason: 'ADJUSTMENT' | 'PURCHASE_RECEIPT' | 'SALES_SHIPMENT'; quantity: Prisma.Decimal; note?: string; purchaseOrderId?: string; salesOrderId?: string }[] = [];
      const pos = await tx.purchaseOrder.findMany({ where: { organizationId: o }, include: { lines: true } });
      for (const po of pos) {
        for (const l of po.lines) {
          const p = productBySku.get(l.productSku);
          if (p && l.receivedQuantity.gt(0)) events.push({ at: po.receivedAt ?? new Date(po.createdAt.getTime() + 10 * DAY), productId: p.id, reason: 'PURCHASE_RECEIPT', quantity: l.receivedQuantity, purchaseOrderId: po.id });
        }
      }
      const shipped = await tx.salesOrder.findMany({ where: { organizationId: o, shippedAt: { not: null }, status: { in: ['SHIPPED', 'DELIVERED'] } }, include: { lines: true } });
      for (const so of shipped) {
        for (const l of so.lines) {
          const p = productBySku.get(l.productSku);
          if (p) events.push({ at: so.shippedAt!, productId: p.id, reason: 'SALES_SHIPMENT', quantity: l.quantity.negated(), salesOrderId: so.id });
        }
      }
      // 期初库存 = 目标期末库存 + 发货 − 收货（且不少于发货量，避免中途为负）；第 3 个产品期末 6（低库存）、第 7 个为 0（缺货）
      // opening = target closing + shipped − received (at least the shipped quantity so it never dips below zero);
      // the 3rd product ends at 6 (low stock), the 7th at 0 (out of stock)
      for (const [i, p] of products.entries()) {
        const net = (reason: string) => events.filter((e) => e.productId === p.id && e.reason === reason).reduce((sum, e) => sum.plus(e.quantity.abs()), new Prisma.Decimal(0));
        const shippedQty = net('SALES_SHIPMENT');
        const target = new Prisma.Decimal(i === 2 ? 6 : i === 6 ? 0 : 40 + ((i * 37) % 160));
        const opening = Prisma.Decimal.max(target.plus(shippedQty).minus(net('PURCHASE_RECEIPT')), shippedQty);
        if (opening.gt(0)) events.push({ at: new Date(Date.now() - 150 * DAY), productId: p.id, reason: 'ADJUSTMENT', quantity: opening, note: '【演示】期初库存' });
      }
      events.sort((x, y) => x.at.getTime() - y.at.getTime());
      for (const e of events) {
        await tx.stockMovement.create({
          data: { organizationId: o, productId: e.productId, reason: e.reason, quantity: e.quantity, note: e.note ?? null, purchaseOrderId: e.purchaseOrderId ?? null, salesOrderId: e.salesOrderId ?? null, actorId: ids.manager, createdAt: e.at },
        });
      }
      // 再订货水平：每隔一个产品设置为 30（第 3 个设为 10，使其显示低库存）/ reorder level 30 on every other product (10 on the 3rd so it shows low)
      for (const [i, p] of products.entries()) {
        if (i % 2 === 0) await tx.product.update({ where: { id: p.id }, data: { reorderLevel: i === 2 ? 10 : 30 } });
      }

      // 报价单审批：规则 + 需要审批的草稿（第 1 张已批准、第 2 张待审批）；原因用与系统相同的计算
      // quote approvals: the policy plus drafts needing approval (1st approved, 2nd pending); reasons use the system's calculation
      await tx.quoteApprovalSettings.create({ data: { organizationId: o, enabled: true, maxDiscountPercent: DEMO_APPROVAL.maxDiscountPercent, minTotal: DEMO_APPROVAL.minTotal, updatedById: ids.admin } });
      await tx.quoteApprovalLevel.createMany({ data: DEMO_APPROVAL.levels.map((l, position) => ({ organizationId: o, position, ...l })) });
      const drafts = await tx.quote.findMany({ where: { organizationId: o, status: 'DRAFT' }, include: { lines: { select: { discountPercent: true } } }, orderBy: { quoteNumber: 'asc' } });
      let decided = 0;
      for (const q of drafts) {
        const reasons = await approvalReasons(tx, o, q);
        if (!reasons.length || decided >= 2) continue;
        const submitter = q.createdById ?? ids.manager;
        const submittedAt = new Date(Date.now() - (2 - decided) * DAY);
        await tx.quoteApproval.create({ data: { organizationId: o, quoteId: q.id, action: 'SUBMIT', actorId: submitter, comment: DEMO_APPROVAL.comments.submit, reasons, createdAt: submittedAt } });
        // 级别快照与系统计算一致；第 1 张由各级审批人逐级批准（演示中每级由不同的人批准）
        // the level snapshot uses the system's calculation; the first quote is approved level by level by different people
        const steps = await approvalSteps(tx, o, q);
        if (decided === 0) {
          const approvers = steps.map((st, k) => (st.role === 'ADMIN' || submitter === ids.manager ? ids.admin : k === 0 ? ids.manager : ids.admin));
          if (new Set(approvers).size !== approvers.length) throw new Error('demo approval needs distinct approvers per level');
          for (const [k, actorId] of approvers.entries()) {
            await tx.quoteApproval.create({ data: { organizationId: o, quoteId: q.id, action: 'APPROVE', actorId, step: k, comment: DEMO_APPROVAL.comments.approve, createdAt: new Date(submittedAt.getTime() + (k + 1) * 3 * 3600_000) } });
          }
        }
        await tx.quote.update({
          where: { id: q.id },
          data: { approvalStatus: decided === 0 ? 'APPROVED' : 'PENDING', approvalReasons: reasons, approvalStep: decided === 0 ? null : 0, approvalSteps: steps as unknown as Prisma.InputJsonValue },
        });
        decided += 1;
      }

      // 自定义字段：定义与各记录的值（按创建顺序）/ custom fields: definitions and values (in creation order)
      for (const [position, f] of DEMO_CUSTOM_FIELDS.entries()) {
        const key = `cf_${createHash('sha256').update(`${o}:${f.label}`).digest('hex').slice(0, 8)}`;
        await tx.customField.create({ data: { organizationId: o, entity: f.entity, key, label: f.label, type: f.type, options: f.options ?? [], position } });
        const table = { LEAD: tx.lead, ACCOUNT: tx.account, CONTACT: tx.contact, DEAL: tx.deal }[f.entity] as unknown as {
          findMany: (a: object) => Promise<{ id: string; custom: Prisma.JsonValue }[]>;
          update: (a: object) => Promise<unknown>;
        };
        const records = await table.findMany({ where: { organizationId: o }, select: { id: true, custom: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        for (const [i, r] of records.entries()) {
          await table.update({ where: { id: r.id }, data: { custom: { ...(r.custom as Record<string, unknown>), [key]: f.value(i) } } });
        }
      }

      // 字段验证规则 / validation rules
      for (const [i, r] of DEMO_VALIDATION_RULES.entries()) {
        await tx.validationRule.create({ data: { organizationId: o, ...r, createdById: ids.admin, createdAt: new Date(Date.now() - (DEMO_VALIDATION_RULES.length - i) * 60_000) } });
      }

      // 演示 Webhook（已停用）/ demo webhook (inactive)
      await tx.webhook.create({ data: { organizationId: o, name: DEMO_WEBHOOK.name, url: DEMO_WEBHOOK.url, secret: `whsec_${randomBytes(24).toString('base64url')}`, isActive: false, createdById: ids.admin } });

      // 工作流规则（标签与用户按键替换为 ID；按顺序创建，执行顺序即创建顺序）
      // workflow rules (tag and user keys replaced by ids; created in order, which is the run order)
      for (const [i, w] of DEMO_WORKFLOWS.entries()) {
        const actions = w.actions.map((a) =>
          a.type === 'ADD_TAG'
            ? { type: a.type, tagId: tagIds[a.tag]! }
            : a.type === 'NOTIFY'
              ? { type: a.type, recipient: a.recipient === 'OWNER' ? 'OWNER' : owner(a.recipient)!, message: a.message }
              : { type: a.type, subject: a.subject, dueInDays: a.dueInDays, assignTo: a.assignTo === 'OWNER' ? 'OWNER' : owner(a.assignTo)! },
        );
        await tx.workflowRule.create({
          data: {
            organizationId: o,
            name: w.name,
            entity: w.entity,
            trigger: w.trigger,
            triggerField: w.triggerField ?? null,
            triggerDays: w.triggerDays ?? null,
            conditions: w.conditions,
            actions,
            isActive: w.isActive,
            createdById: ids.admin,
            createdAt: new Date(Date.now() - (DEMO_WORKFLOWS.length - i) * 60_000),
          },
        });
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

      // 站内通知（分配通知）/ in-app notifications (assignments)
      const notices = demoNotifications(data);
      await tx.notification.createMany({
        data: notices.map((n) => ({
          organizationId: o,
          userId: ids[n.to],
          type: 'ASSIGNED' as const,
          actorId: ids[n.from],
          leadId: 'lead' in n.target ? leadIds[n.target.lead] : null,
          accountId: 'account' in n.target ? accountIds[n.target.account] : null,
          dealId: 'deal' in n.target ? dealIds[n.target.deal] : null,
          title: n.title,
          createdAt: new Date(Date.now() - n.hoursAgo * 3600_000),
          readAt: n.read ? new Date(Date.now() - (n.hoursAgo - 1) * 3600_000) : null,
        })),
      });
    },
    { timeout: 60_000 },
  );
  // 事务提交后写入附件文件 / write attachment files after the commit
  for (const f of files) await saveFile(o, f.id, f.data);

  console.log(
    `演示数据已${options.reset ? '重建' : '创建'}：${data.accounts.length + 1} 客户（含 1 条重复）、${data.accounts.reduce((n, a) => n + a.contacts.length, 0) + 2} 联系人、` +
      `${data.leads.length + 2} 线索（含 2 条重复）、${data.deals.length} 商机、${data.activities.length} 跟进、${data.notes.length} 备注、${data.products.length} 产品、${data.items.length} 产品明细、${data.quotes.length} 报价单、${demoOrders(data).length} 销售订单、${demoInvoices(data).length} 发票、${DEMO_RATES.length} 条汇率、${DEMO_CAMPAIGNS.length} 个市场活动、${demoDealCompetitors(data).length} 个竞争对手、${demoContactRoles(data).length} 个联系人角色、${demoTickets(data).length} 个服务工单（${Object.values(DEMO_TICKET_COMMENTS).flat().length} 条处理记录）、${DEMO_KB_ARTICLES.length} 篇知识库文章、${DEMO_VENDORS.length} 个供应商、${DEMO_PURCHASE_ORDERS.length} 张采购单、${DEMO_PRICE_BOOKS.length} 张价格表、${DEMO_WEB_FORMS.length} 个网页表单、${DEMO_ASSIGNMENT_RULES.length} 条分配规则、${DEMO_WORKFLOWS.length} 条工作流规则、${DEMO_SCORING.rules.length + DEMO_ACCOUNT_SCORING.rules.length + DEMO_CONTACT_SCORING.rules.length + DEMO_DEAL_SCORING.rules.length} 条评分规则、${DEMO_TAGS.length} 标签、${files.length} 附件、${DEMO_TARGETS.length * DEMO_TARGET_MONTHS.length} 条销售目标、${demoNotifications(data).length} 条通知 / demo data ready`,
  );
}

// 直接运行时执行 / run when executed directly
if (process.argv[1]?.endsWith('seed-demo.ts')) {
  await seedDemo({ reset: process.argv.includes('--reset') });
  await prisma.$disconnect();
}
